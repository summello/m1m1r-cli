import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  width: number;
  height: number;
}

export function useTerminalSize(widthOverride?: number): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({
    width: Math.max(1, widthOverride ?? stdout.columns ?? 80),
    height: Math.max(1, (stdout as NodeJS.WriteStream & { rows?: number }).rows ?? 24),
  });
  const [size, setSize] = useState(read);

  useEffect(() => {
    const resize = () => setSize(read());
    stdout.on('resize', resize);
    resize();
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout, widthOverride]);

  return size;
}
