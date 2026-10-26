import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeConfigSchema } from '../src/types.js';
import { HermesCliProvider } from '../src/providers/hermes-cli.js';
import { runCommand } from '../src/command.js';
vi.mock('../src/command.js', () => ({ runCommand: vi.fn() }));
const run = vi.mocked(runCommand);
const config = () => BridgeConfigSchema.parse({ hermes: { command: 'synthetic-hermes', defaultCwd: '/synthetic', timeoutMs: 500 }, kanban: { enabled: true, board: 'synthetic', dispatcherProfile: 'dispatcher' } });
afterEach(() => vi.resetAllMocks());

describe('Hermes provider invocation contract (mock, never live)', () => {
  it('keeps prompt as one argv value, honors cwd, toolsets and timeout', async () => {
    run.mockResolvedValue({ code: 0, stdout: ' answer\n', stderr: '' });
    const provider = new HermesCliProvider(config());
    const result = await provider.askAgent({ profile: 'fixture', prompt: 'quote " ; $(no-shell)', cwd: '/fixture', toolsets: ['terminal'], timeoutMs: 250 });
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toBe('synthetic-hermes');
    expect(args.slice(0, 5)).toEqual(['--profile', 'fixture', '--toolsets', 'terminal', '--oneshot']);
    expect(args).toHaveLength(6);
    expect(args[5]).toContain('quote " ; $(no-shell)');
    expect(options).toMatchObject({ cwd: '/fixture', timeoutMs: 250 });
    expect(result.text).toBe('answer');
  });
  it('never accepts nonzero or signal-close as success', async () => {
    for (const code of [1, null]) {
      run.mockResolvedValue({ code, stdout: 'partial', stderr: 'failure' });
      await expect(new HermesCliProvider(config()).askAgent({ profile: 'fixture', prompt: 'test' })).rejects.toThrow();
    }
  });
  it('propagates spawn/timeout errors without retry', async () => {
    run.mockRejectedValue(new Error('synthetic timeout'));
    await expect(new HermesCliProvider(config()).askAgent({ profile: 'fixture', prompt: 'test' })).rejects.toThrow('timeout');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('disabled kanban has no command side effect', async () => {
    const cfg = config(); cfg.kanban.enabled = false;
    await expect(new HermesCliProvider(cfg).createKanbanTask({ title: 't', body: 'b' })).rejects.toThrow('disabled');
    expect(run).not.toHaveBeenCalled();
  });
});
