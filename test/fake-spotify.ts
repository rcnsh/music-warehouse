import { SpotifyError } from '../src/spotify';
import { type SpotifyCall, setSpotifyTransport } from '../src/spotify-client';

/**
 * Answer every Spotify call with `answer` in place of api.spotify.com, for
 * route tests. No grant is read and no token minted, so none need seeding,
 * and nothing is counted or paused: a 429 is thrown as `rate_limited`, as
 * the real transport throws it, and is forgotten. Tests of the pause and the
 * counts stub fetch instead, to run the real transport (test/quota.test.ts).
 *
 * Returns the calls made, and their paths under /v1, both filled as they happen.
 * test/setup.ts restores the real transport after each test.
 */
export function fakeSpotify(answer: (call: SpotifyCall) => Response | Promise<Response>) {
  const calls: SpotifyCall[] = [];
  const paths: string[] = [];
  setSpotifyTransport(() => ({
    async send(call) {
      calls.push(call);
      paths.push(call.path);
      const response = await answer(call);
      if (response.status !== 429) return response;
      const retryAfter = response.headers.get('Retry-After');
      throw new SpotifyError('rate_limited', `Rate limited on ${call.path}.`, {
        status: 429,
        retryAfterSeconds: retryAfter === null ? null : Number(retryAfter),
      });
    },
    assertOpen: async () => {},
    ready: async () => {},
    refreshToken: () => {},
  }));
  return { calls, paths };
}
