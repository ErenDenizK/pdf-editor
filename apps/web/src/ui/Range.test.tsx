import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Range, rangeFill } from './Range';

afterEach(cleanup);

describe('Range', () => {
  it('places the fill at the value, clamped to the range', () => {
    expect(rangeFill(10, 10, 100)).toBe('0%');
    expect(rangeFill(55, 10, 100)).toBe('50%');
    expect(rangeFill(100, 10, 100)).toBe('100%');
    expect(rangeFill(120, 10, 100)).toBe('100%');
    expect(rangeFill(1, 0, 3)).toBe('33.33%');
    expect(rangeFill(5, 5, 5)).toBe('0%');
  });

  it('renders a range input with its fill and passes the rest through', () => {
    const { getByRole } = render(
      <Range aria-label="Opacity" min={0} max={100} step={5} value={25} readOnly />,
    );
    const input = getByRole('slider', { name: 'Opacity' }) as HTMLInputElement;
    expect(input.type).toBe('range');
    expect(input.value).toBe('25');
    expect(input.style.getPropertyValue('--fill')).toBe('25%');
  });
});
