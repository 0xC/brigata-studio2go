// STANDALONE BUILD STUB — swapped in for src/bridges.ts by
// scripts/package-studio-to-go.sh. Self-host mode has no channel connectors
// (Discord / Matrix), so outbound mirroring is a no-op. The exported signatures
// match the cloud module exactly so the core call sites (agents.ts, messages.ts)
// compile and run unchanged. The real connector source is never shipped.

export type OutboundSource = 'native' | 'discord' | 'telegram' | 'matrix'

export function forwardOutbound(
  _channelId: string,
  _body: string,
  _source: OutboundSource,
  _authorLabel: string,
): void {}

export function forwardTyping(_channelId: string, _typing: boolean): void {}
