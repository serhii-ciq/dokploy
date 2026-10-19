import { beforeEach, describe, expect, it, vi } from "vitest";

// Each findServiceRef lookup ends in .limit(1); rows are served in query order:
// application, postgres, mysql, mariadb, mongo, redis, libsql, compose.
const rows = vi.hoisted(() => ({ queue: [] as unknown[][] }));
vi.mock("@dokploy/server/db", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(rows.queue.shift() ?? []),
	};
	return { db: chain };
});

const mockExecAsync = vi.hoisted(() => vi.fn());
const mockExecAsyncRemote = vi.hoisted(() => vi.fn());
vi.mock("@dokploy/server", () => ({
	execAsync: mockExecAsync,
	execAsyncRemote: mockExecAsyncRemote,
}));

import { serviceOwnsTarget } from "@/server/wss/service-target";

const asApplication = (row: object) => {
	rows.queue = [[row]];
};
const asCompose = (row: object) => {
	rows.queue = [[], [], [], [], [], [], [], [row]];
};
const labels = (swarm: string, project: string, stack: string) => ({
	stdout: `${swarm}|${project}|${stack}\n`,
	stderr: "",
});

beforeEach(() => {
	vi.clearAllMocks();
	rows.queue = [];
});

describe("serviceOwnsTarget", () => {
	it("denies without a target", async () => {
		expect(await serviceOwnsTarget("svc-1", null, undefined)).toBe(false);
	});

	it("denies an unknown service", async () => {
		expect(
			await serviceOwnsTarget("missing", null, { containerId: "abc" }),
		).toBe(false);
		expect(mockExecAsync).not.toHaveBeenCalled();
	});

	it("allows a container of the swarm service", async () => {
		asApplication({ appName: "vs-test-xm0sbh", serverId: null });
		mockExecAsync.mockResolvedValue(labels("vs-test-xm0sbh", "", ""));
		expect(
			await serviceOwnsTarget("svc-1", null, {
				containerId: "vs-test-xm0sbh.1.dnwwv6dj503qwrnasd5ufkx7z",
			}),
		).toBe(true);
	});

	it("denies a container of another swarm service", async () => {
		asApplication({ appName: "vs-test-xm0sbh", serverId: null });
		mockExecAsync.mockResolvedValue(labels("dokploy-postgres", "", ""));
		expect(
			await serviceOwnsTarget("svc-1", "local", {
				containerId: "dokploy-postgres.1.i2l035d4ryfol8j8dt161vkad",
			}),
		).toBe(false);
	});

	it("denies a container without swarm labels (e.g. dokploy-traefik)", async () => {
		asApplication({ appName: "vs-test-xm0sbh", serverId: null });
		mockExecAsync.mockResolvedValue(labels("", "", ""));
		expect(
			await serviceOwnsTarget("svc-1", null, {
				containerId: "dokploy-traefik",
			}),
		).toBe(false);
	});

	it("matches docker-compose containers by compose project", async () => {
		asCompose({
			appName: "argus-abc",
			serverId: null,
			composeType: "docker-compose",
		});
		mockExecAsync.mockResolvedValue(labels("", "argus-abc", ""));
		expect(
			await serviceOwnsTarget("cmp-1", null, {
				containerId: "argus-abc-web-1",
			}),
		).toBe(true);
	});

	it("matches stack containers by stack namespace, not the swarm service", async () => {
		asCompose({ appName: "argus-abc", serverId: null, composeType: "stack" });
		mockExecAsync.mockResolvedValue(labels("argus-abc_web", "", "argus-abc"));
		expect(
			await serviceOwnsTarget("cmp-1", null, {
				containerId: "argus-abc_web.1.xyz",
			}),
		).toBe(true);
	});

	it("inspects on the service's remote server", async () => {
		asApplication({ appName: "app-1", serverId: "srv-1" });
		mockExecAsyncRemote.mockResolvedValue(labels("app-1", "", ""));
		expect(
			await serviceOwnsTarget("svc-1", "srv-1", { containerId: "app-1.1.abc" }),
		).toBe(true);
		expect(mockExecAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			expect.stringContaining("docker inspect"),
		);
		expect(mockExecAsync).not.toHaveBeenCalled();
	});

	it("denies when the requested server differs from the service's server", async () => {
		asApplication({ appName: "app-1", serverId: "srv-1" });
		expect(
			await serviceOwnsTarget("svc-1", null, { containerId: "app-1.1.abc" }),
		).toBe(false);
		expect(mockExecAsync).not.toHaveBeenCalled();
		expect(mockExecAsyncRemote).not.toHaveBeenCalled();
	});

	it("denies when docker inspect fails", async () => {
		asApplication({ appName: "app-1", serverId: null });
		mockExecAsync.mockRejectedValue(new Error("No such object"));
		expect(
			await serviceOwnsTarget("svc-1", null, { containerId: "app-1.1.abc" }),
		).toBe(false);
	});

	it("compares appName targets with the service's appName", async () => {
		asApplication({ appName: "app-1", serverId: "srv-1" });
		expect(await serviceOwnsTarget("svc-1", null, { appName: "app-1" })).toBe(
			true,
		);
		asApplication({ appName: "app-1", serverId: null });
		expect(await serviceOwnsTarget("svc-1", null, { appName: "dokploy" })).toBe(
			false,
		);
	});
});
