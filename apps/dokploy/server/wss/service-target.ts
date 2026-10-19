import { execAsync, execAsyncRemote } from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";

export type ServiceRef = {
	appName: string;
	serverId: string | null;
	kind: "swarm" | "docker-compose" | "stack";
};

export type WssTarget = { containerId: string } | { appName: string };

const normalizeServerId = (serverId?: string | null) =>
	!serverId || serverId === "local" ? null : serverId;

export const findServiceRef = async (
	serviceId: string,
): Promise<ServiceRef | null> => {
	const swarmTables = [
		{ table: applications, id: applications.applicationId },
		{ table: postgres, id: postgres.postgresId },
		{ table: mysql, id: mysql.mysqlId },
		{ table: mariadb, id: mariadb.mariadbId },
		{ table: mongo, id: mongo.mongoId },
		{ table: redis, id: redis.redisId },
		{ table: libsql, id: libsql.libsqlId },
	] as const;

	for (const { table, id } of swarmTables) {
		const [row] = await db
			.select({ appName: table.appName, serverId: table.serverId })
			.from(table)
			.where(eq(id, serviceId))
			.limit(1);
		if (row) return { ...row, kind: "swarm" };
	}

	const [row] = await db
		.select({
			appName: compose.appName,
			serverId: compose.serverId,
			composeType: compose.composeType,
		})
		.from(compose)
		.where(eq(compose.composeId, serviceId))
		.limit(1);
	if (row) {
		return {
			appName: row.appName,
			serverId: row.serverId,
			kind: row.composeType === "stack" ? "stack" : "docker-compose",
		};
	}

	return null;
};

const LABELS =
	'{{index .Config.Labels "com.docker.swarm.service.name"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.stack.namespace"}}';

export const containerBelongsToService = async (
	containerId: string,
	service: ServiceRef,
): Promise<boolean> => {
	const command = `docker inspect --format ${quote([LABELS])} ${quote([containerId])}`;
	try {
		const { stdout } = service.serverId
			? await execAsyncRemote(service.serverId, command)
			: await execAsync(command);
		const [swarmService, composeProject, stackNamespace] = stdout
			.trim()
			.split("|");
		switch (service.kind) {
			case "swarm":
				return swarmService === service.appName;
			case "docker-compose":
				return composeProject === service.appName;
			case "stack":
				return stackNamespace === service.appName;
		}
	} catch {
		return false;
	}
};

// A serviceId only proves access to that service. The container (or appName)
// the socket operates on must belong to it, otherwise any member could pass
// the id of their own service and reach every container on the host.
export const serviceOwnsTarget = async (
	serviceId: string,
	serverId: string | null | undefined,
	target: WssTarget | undefined,
): Promise<boolean> => {
	if (!target) return false;
	const service = await findServiceRef(serviceId);
	if (!service) return false;
	if ("appName" in target) return target.appName === service.appName;
	if (normalizeServerId(serverId) !== normalizeServerId(service.serverId)) {
		return false;
	}
	return containerBelongsToService(target.containerId, service);
};
