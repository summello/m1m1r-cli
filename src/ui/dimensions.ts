import { useSyncExternalStore } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  width: number;
  height: number;
}

interface SizeStore {
  size: TerminalSize;
  listeners: Set<() => void>;
}

const stores = new WeakMap<NodeJS.WriteStream, SizeStore>();
const boundStreams = new WeakSet<NodeJS.WriteStream>();

function readSize(stdout: NodeJS.WriteStream): TerminalSize {
  return {
    width: Math.max(1, stdout.columns ?? 80),
    height: Math.max(1, (stdout as NodeJS.WriteStream & { rows?: number }).rows ?? 24),
  };
}

function getStore(stdout: NodeJS.WriteStream): SizeStore {
  let store = stores.get(stdout);
  if (!store) {
    store = { size: readSize(stdout), listeners: new Set() };
    stores.set(stdout, store);
  }
  return store;
}

function subscribe(stdout: NodeJS.WriteStream, onChange: () => void): () => void {
  const store = getStore(stdout);
  store.listeners.add(onChange);
  if (!boundStreams.has(stdout)) {
    boundStreams.add(stdout);
    stdout.on('resize', () => {
      store.size = readSize(stdout);
      store.listeners.forEach((listener) => listener());
    });
  }
  return () => {
    store.listeners.delete(onChange);
  };
}

export function useTerminalSize(widthOverride?: number): TerminalSize {
  const { stdout } = useStdout();
  const size = useSyncExternalStore(
    (onChange) => subscribe(stdout, onChange),
    () => getStore(stdout).size,
  );
  return widthOverride === undefined
    ? size
    : { width: Math.max(1, widthOverride), height: size.height };
}
