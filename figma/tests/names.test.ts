import { describe, expect, it } from 'vitest';
import { genericNameReason, isGenericLayerName, suggestName } from '../src/lib/names';

describe('generic layer names', () => {
  it.each([
    ['Rectangle 12', 'default'],
    ['Frame 3', 'default'],
    ['Group', 'default'],
    ['Ellipse 4 copy', 'default'],
    ['Mask group', 'default'],
    ['image 4', 'default'],
    ['Button 2', 'default'],
    ['Vector', 'default'],
    ['hero.png', 'file'],
    ['Screen Shot 2024-01-02 at 10.00.00.jpg', 'file'],
    ['logo.SVG', 'file'],
    ['icons8-trophy-32 1', 'export'],
    ['icons8-help', 'export'],
    ['pexels-photo-1234', 'export'],
    ['IMG_2041', 'export'],
    ['ic_arrow_back_24px', 'export'],
    ['arrow-left-24 2', 'export'],
    ['12', 'export'],
    ['', 'empty'],
    ['   ', 'empty'],
  ])('flags %j as %s', (name, reason) => {
    expect(genericNameReason(name)).toBe(reason);
  });

  it.each(['Yes!', 'Continue', 'Sign in with your bank', 'Back', 'Copy', 'Plan card / Pro', 'Sign-up 2', 'Step 2 of 3', 'Checkout'])('keeps %j', (name) => {
    expect(isGenericLayerName(name)).toBe(false);
  });

  it('handles null', () => {
    expect(isGenericLayerName(null)).toBe(true);
  });

  it('suggests a name from the text inside the layer', () => {
    expect(suggestName('  Use routing\nnumber instead ')).toBe('Use routing number instead');
    expect(suggestName('Rectangle 3')).toBeNull();
    expect(suggestName('x'.repeat(41))).toBeNull();
    expect(suggestName(null)).toBeNull();
  });
});
