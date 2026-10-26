import { expect, it } from 'vitest';
import { runCommand } from '../src/command.js';

it('passes literal argv without a shell', async () => {
  const value = 'a; echo forbidden $(exit 9) "quoted"';
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(value);
});
it('preserves exit code and stderr', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stderr.write("fixture");process.exit(7)']);
  expect(result).toMatchObject({ code: 7, stderr: 'fixture' });
});
it('reports a killed timeout as non-success', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 });
  expect(result.code).not.toBe(0);
}, 10000);
it('rejects a missing executable', async () => {
  await expect(runCommand('/nonexistent-synthetic-command', [])).rejects.toThrow();
});
