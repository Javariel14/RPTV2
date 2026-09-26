/** Exact rational arithmetic. Only display/settlement boundaries round. */
export class Exact {
  readonly numerator: bigint;
  readonly denominator: bigint;
  constructor(n: bigint, d = 1n) {
    if (d <= 0n) throw new RangeError('invalid denominator');
    let a = n < 0n ? -n : n,
      b = d;
    while (b !== 0n) [a, b] = [b, a % b];
    this.numerator = n / a;
    this.denominator = d / a;
  }
  static parse(s: string) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s) || s.length > 80)
      throw new RangeError('invalid exact decimal');
    const negative = s.startsWith('-');
    const [w, f = ''] = (negative ? s.slice(1) : s).split('.');
    return new Exact(BigInt(w + f) * (negative ? -1n : 1n), 10n ** BigInt(f.length));
  }
  add(v: Exact) {
    return new Exact(
      this.numerator * v.denominator + v.numerator * this.denominator,
      this.denominator * v.denominator,
    );
  }
  sub(v: Exact) {
    return this.add(new Exact(-v.numerator, v.denominator));
  }
  mul(v: Exact) {
    return new Exact(this.numerator * v.numerator, this.denominator * v.denominator);
  }
  div(v: Exact) {
    if (v.numerator <= 0n) throw new RangeError('positive divisor required');
    return new Exact(this.numerator * v.denominator, this.denominator * v.numerator);
  }
  compare(v: Exact) {
    const d = this.numerator * v.denominator - v.numerator * this.denominator;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  format(scale: number) {
    if (!Number.isInteger(scale) || scale < 0 || scale > 40) throw new RangeError('invalid scale');
    const sign = this.numerator < 0n ? '-' : '';
    const n = (this.numerator < 0n ? -this.numerator : this.numerator) * 10n ** BigInt(scale);
    const rounded =
      n / this.denominator + ((n % this.denominator) * 2n >= this.denominator ? 1n : 0n);
    const s = rounded.toString().padStart(scale + 1, '0');
    return `${rounded === 0n ? '' : sign}${scale ? s.slice(0, -scale) + '.' + s.slice(-scale) : s}`;
  }
}
