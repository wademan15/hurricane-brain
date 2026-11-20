import type { DeviceView } from '../session/controller';

export function deviceText(d: DeviceView, what: string): { text: string; tone: 'default' | 'ok' | 'warn' | 'bad' } {
  switch (d.state) {
    case 'none':
    case 'idle':
      return { text: `${what} not connected`, tone: 'default' };
    case 'requesting':
      return { text: 'Choose the device in the list that opened', tone: 'default' };
    case 'connecting':
      return { text: 'Connecting', tone: 'warn' };
    case 'starting':
      return { text: 'Starting the stream', tone: 'warn' };
    case 'streaming':
      return { text: 'Streaming', tone: 'ok' };
    case 'reconnecting':
      return { text: `Reconnecting${d.attempt ? ` (attempt ${d.attempt}${d.retryInMs ? `, next in ${Math.round(d.retryInMs / 1000)} s` : ''})` : ''}`, tone: 'warn' };
    case 'stopped':
      return { text: 'Disconnected', tone: 'default' };
    case 'failed':
      return { text: `Connection failed${d.detail ? `: ${d.detail}` : ''}`, tone: 'bad' };
    case 'replaying':
      return { text: 'Replaying', tone: 'ok' };
    case 'ended':
      return { text: 'Replay finished', tone: 'default' };
  }
}
