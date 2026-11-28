// All generated PNGs, resolved to URLs by Vite. Names are the file stem.
const urls = import.meta.glob('./*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export function assetUrl(name: string): string {
  return urls[`./${name}.png`] ?? '';
}
