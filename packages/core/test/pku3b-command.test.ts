import { afterEach, expect, it, vi } from 'vitest';
import { Pku3bAdapter } from '../src/integrations/pku3b/pku3b-adapter.js';
import { BlackboardReader } from '../src/integrations/pku3b/blackboard-reader.js';
import { TeachingAccessError } from '../src/integrations/pku3b/structured-types.js';
afterEach(() => vi.restoreAllMocks());

it('passes all-term when downloading a synchronized historical assignment', async () => {
  const adapter = new Pku3bAdapter();
  const execute = vi.spyOn(adapter as unknown as { execute(args: string[], timeout: number): Promise<{stdout: string; stderr: string}> }, 'execute')
    .mockImplementation(async args => ({ stdout: args.includes('--version') ? 'pku3b 0.16.0' : JSON.stringify(args), stderr: '' }));
  const result = await adapter.runWrite({ kind: 'assignment-download', id: 'historical-id', outdir: '/course/staging', allTerm: true });
  expect(result.ok).toBe(true);
  expect(execute).toHaveBeenLastCalledWith(['assignment', 'download', 'historical-id', '--dir', '/course/staging', '--all-term'], 120000);
});

it('refreshes an expired structured session once and preserves the provided OTP', async () => {
  const adapter = new Pku3bAdapter({ cacheDir: '/unused' });
  vi.spyOn(adapter, 'version').mockResolvedValue({ ok: true, data: { version: '0.16.0', supported: true } });
  const refresh = vi.spyOn(adapter, 'runRead').mockResolvedValue({ ok: true, data: { version: '0.16.0', stdout: '', stderr: '' } });
  const read = vi.spyOn(BlackboardReader.prototype, 'listCourses')
    .mockRejectedValueOnce(new TeachingAccessError('TEACHING_AUTH_REQUIRED', 'expired'))
    .mockResolvedValue([{ remoteCourseId: '_1_1', title: 'Course', isCurrent: true }]);
  expect((await adapter.structured!.listCourses({ otp: '123456' })).ok).toBe(true);
  expect(refresh).toHaveBeenCalledExactlyOnceWith({ kind: 'course-content-list', allTerm: true, force: true, otp: '123456' });
  expect(read).toHaveBeenCalledTimes(2);
});

it('propagates OTP requirements and never masks schema changes with a legacy text fallback', async () => {
  const adapter = new Pku3bAdapter({ cacheDir: '/unused' });
  vi.spyOn(adapter, 'version').mockResolvedValue({ ok: true, data: { version: '0.16.0', supported: true } });
  const refresh = vi.spyOn(adapter, 'runRead').mockResolvedValue({ ok: false, error: { code: 'PKU3B_AUTH_OTP_REQUIRED', message: 'OTP required', retryable: true }, requiresAction: 'provide_otp' });
  const read = vi.spyOn(BlackboardReader.prototype, 'listCourses').mockRejectedValue(new TeachingAccessError('TEACHING_AUTH_REQUIRED', 'expired'));
  expect(await adapter.structured!.listCourses()).toMatchObject({ ok: false, requiresAction: 'provide_otp' });
  refresh.mockClear();
  read.mockRejectedValue(new TeachingAccessError('TEACHING_SCHEMA_CHANGED', 'changed'));
  expect(await adapter.structured!.listCourses()).toMatchObject({ ok: false, error: { code: 'TEACHING_SCHEMA_CHANGED' } });
  expect(refresh).not.toHaveBeenCalled();
});
