import fs from 'fs';
import path from 'path';

const SHIPPED_DOTFILES: Record<string, string> = {
  'gitignore.template': '.gitignore',
  'npmignore.template': '.npmignore',
  'env.example.template': '.env.example',
};

/** The name a shipped template file is written under: `gitignore.template` → `.gitignore`. */
export function shippedDotfileName(name: string): string {
  return SHIPPED_DOTFILES[name] ?? name;
}

// npm strips .gitignore files and honours nested .npmignore files when packing
// the CLI, so templates ship dotfiles under neutral names and scaffolding
// restores them, at any depth.
export function renameShippedDotfiles(folder: string): void {
  for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') renameShippedDotfiles(full);
    } else if (SHIPPED_DOTFILES[entry.name]) {
      fs.renameSync(full, path.join(folder, SHIPPED_DOTFILES[entry.name]));
    }
  }
}
