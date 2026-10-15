import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';

describe('log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one object with the event, level and fields', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('poll', { result: { inserted: 3 } });
    expect(info).toHaveBeenCalledWith({ event: 'poll', level: 'info', result: { inserted: 3 } });
  });

  it('routes by level and flattens errors to plain fields', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log('rollup-failed', { error: new TypeError('boom') }, 'error');
    log('alert-no-webhook', { key: 'k' }, 'warn');
    expect(error.mock.calls[0]![0]).toMatchObject({
      event: 'rollup-failed',
      level: 'error',
      error: { name: 'TypeError', message: 'boom' },
    });
    expect(warn).toHaveBeenCalledWith({ event: 'alert-no-webhook', level: 'warn', key: 'k' });
  });
});
