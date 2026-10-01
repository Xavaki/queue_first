import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalCategory,
  parseAddToPlaylist,
  parsePlaylistPage,
  parseWatchHtml,
} from '../src/adapters/youtube/parsers';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('metadata parser', () => {
  it('reads the category of the requested video without eval', () => {
    const m = parseWatchHtml(fx('watch-music.html'), 'MUSICvid001');
    expect(m).toMatchObject({ category: 'MUSIC', rawCategory: 'Music', lengthSeconds: 215, availability: 'available' });
    expect(m!.title).toBe('A song "quoted" {braces}');
  });

  it('refuses metadata belonging to another video', () => {
    expect(parseWatchHtml(fx('watch-mismatch.html'), 'MUSICvid001')).toBeNull();
    expect(parseWatchHtml(fx('watch-music.html'), 'OTHERvid001')).toBeNull();
  });

  it('reports positive unavailability', () => {
    expect(parseWatchHtml(fx('watch-unavailable.html'), 'MUSICvid001')).toMatchObject({ availability: 'unavailable', category: 'UNKNOWN' });
  });

  it('maps categories conservatively', () => {
    expect(canonicalCategory('Music')).toBe('MUSIC');
    expect(canonicalCategory('Música')).toBe('MUSIC');
    expect(canonicalCategory('Gaming')).toBe('NON_MUSIC');
    expect(canonicalCategory('Jeux vidéo')).toBe('UNKNOWN');
    expect(canonicalCategory('')).toBe('UNKNOWN');
    expect(canonicalCategory(null)).toBe('UNKNOWN');
  });
});

describe('Watch Later parsers', () => {
  it('reads rows and the continuation token', () => {
    const p1 = parsePlaylistPage(JSON.parse(fx('wl-page1.json')));
    expect(p1.items.map((i) => i.videoId)).toEqual(['AAAAAAAAAA1', 'BBBBBBBBBB2', 'CCCCCCCCCC3']);
    expect(p1.items[2]).toMatchObject({ playable: false, unavailableReason: '[Private video]' });
    expect(p1.continuation).toBe('TOKEN-PAGE-2');
    const p2 = parsePlaylistPage(JSON.parse(fx('wl-page2.json')));
    expect(p2.items).toEqual([{ videoId: 'DDDDDDDDDD4', title: 'Fourth video', setVideoId: 'SET4', playable: true }]);
    expect(p2.continuation).toBeNull();
  });

  it('reads Watch Later membership', () => {
    expect(parseAddToPlaylist(JSON.parse(fx('add-to-playlist.json')))).toBe(true);
    expect(parseAddToPlaylist({})).toBeNull();
  });
});
