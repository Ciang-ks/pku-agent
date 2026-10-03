import { expect, it, vi } from "vitest";
import { CourseDiscoveryService } from "../src/integrations/pku3b/course-discovery-service.js";
import type { Pku3bExecutor } from "../src/integrations/pku3b/teaching-network-service.js";
import type { CourseWorkspaceService } from "../src/storage/course-workspace-service.js";

it("relogs once when pku3b accepts a logged-out portal after init", async () => {
  const runRead = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: "PKU3B_COMMAND_FAILED", message: "fetch course handles: courses not found" } }).mockResolvedValueOnce({ ok: true, data: { stdout: "人工智能中的编程(秋)\n• (Document) 第一讲 _100_1:_200_1\n" } });
  const service = new CourseDiscoveryService({ runRead } as unknown as Pku3bExecutor, { list: () => [] } as unknown as CourseWorkspaceService);
  expect(await service.discover("123456")).toEqual([{ title: "人工智能中的编程(秋)", remoteCourseId: "_100_1" }]);
  expect(runRead).toHaveBeenLastCalledWith({ kind: "course-content-list", allTerm: true, force: true, otp: "123456" });
});
it("bounds retries and preserves authentication actions", async () => {
  const runRead = vi.fn().mockResolvedValue({ ok: false, error: { code: "PKU3B_COMMAND_FAILED", message: "courses not found" } });
  const service = new CourseDiscoveryService({ runRead } as unknown as Pku3bExecutor, {} as CourseWorkspaceService);
  await expect(service.discover()).rejects.toThrow("courses not found");
  expect(runRead).toHaveBeenCalledTimes(2);
  runRead.mockClear().mockResolvedValue({ ok: false, error: { code: "PKU3B_AUTH_OTP_REQUIRED", message: "OTP required" }, requiresAction: { type: "provide_otp" } });
  await expect(service.discover()).rejects.toMatchObject({ statusCode: 401 });
  expect(runRead).toHaveBeenCalledTimes(1);
});
