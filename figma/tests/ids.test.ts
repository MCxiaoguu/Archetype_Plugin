import { describe, expect, it } from 'vitest';
import { isColonId, isDashId, nodeIdFromUrl, toColonId, toDashId } from '../src/lib/ids';

describe('node id conversions', () => {
  it('turns plugin ids into URL ids and back', () => {
    expect(toDashId('71:616')).toBe('71-616');
    expect(toColonId('71-616')).toBe('71:616');
    expect(toColonId(toDashId('1:3'))).toBe('1:3');
  });

  it('accepts either spelling on either side', () => {
    expect(toDashId('71-616')).toBe('71-616');
    expect(toColonId('71:616')).toBe('71:616');
    expect(toColonId('71%3A616')).toBe('71:616');
    expect(toColonId(' 5-9 ')).toBe('5:9');
  });

  it('rejects instance paths and junk', () => {
    expect(() => toDashId('I71:616;12:3')).toThrow();
    expect(() => toDashId('frame')).toThrow();
    expect(() => toColonId('1-2-3')).toThrow();
    expect(() => toColonId('%E0%A4%A')).toThrow();
  });

  it('recognises each form', () => {
    expect(isColonId('71:616')).toBe(true);
    expect(isColonId('I1:2;3:4')).toBe(true);
    expect(isColonId('71-616')).toBe(false);
    expect(isDashId('71-616')).toBe(true);
    expect(isDashId('71:616')).toBe(false);
  });

  it('reads node-id from prototype URLs', () => {
    expect(nodeIdFromUrl('https://www.figma.com/proto/KEY/x?node-id=71-616&starting-point-node-id=1%3A3')).toBe('71:616');
    expect(nodeIdFromUrl('https://www.figma.com/proto/KEY/x?node-id=71%3A616')).toBe('71:616');
    expect(nodeIdFromUrl('https://www.figma.com/proto/KEY/x?starting-point-node-id=1%3A3')).toBeNull();
    expect(nodeIdFromUrl('https://www.figma.com/proto/KEY/x?node-id=nope')).toBeNull();
    expect(nodeIdFromUrl('not a url')).toBeNull();
    expect(nodeIdFromUrl(null)).toBeNull();
  });
});
