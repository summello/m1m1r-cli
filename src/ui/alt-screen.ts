// Alternate screen buffer: the cockpit gets the whole terminal on launch and
// the shell's scrollback comes back untouched on exit. Ink has no option for
// this, so the DEC private mode is driven directly.
const ENTER = '\x1b[?1049h\x1b[H';
const LEAVE = '\x1b[?1049l';

export function enterAltScreen(stream: NodeJS.WriteStream = process.stdout): () => void {
  if (!stream.isTTY) return () => {};
  stream.write(ENTER);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stream.write(LEAVE);
  };
  // Covers crashes and signals too — without it a hard exit strands the user
  // in the alternate buffer with no prompt.
  process.once('exit', restore);
  return restore;
}
