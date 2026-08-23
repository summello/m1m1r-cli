import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TreeLine {
  depth: number;
  name: string;
  isDir: boolean;
  last: boolean;
}

/** Tracked + untracked-but-not-ignored paths, so .gitignore is honored without
 * reimplementing its matching rules. */
export async function readRepoPaths(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.split('\n').filter(Boolean);
}

interface Node {
  name: string;
  isDir: boolean;
  children: Map<string, Node>;
}

export function buildTree(paths: readonly string[], maxDepth = 1): TreeLine[] {
  const root: Node = { name: '', isDir: true, children: new Map() };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    parts.forEach((part, index) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, isDir: index < parts.length - 1, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
  }

  const lines: TreeLine[] = [];
  const walk = (node: Node, depth: number): void => {
    if (depth > maxDepth) return;
    const children = [...node.children.values()].sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
    children.forEach((child, index) => {
      lines.push({ depth, name: child.name, isDir: child.isDir, last: index === children.length - 1 });
      if (child.isDir) walk(child, depth + 1);
    });
  };
  walk(root, 0);
  return lines;
}

export function treePrefix(line: TreeLine): string {
  return `${'  '.repeat(line.depth)}${line.last ? '└─' : '├─'} `;
}
