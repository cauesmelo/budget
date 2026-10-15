const GROUP_INTEGER = /\B(?=(\d{3})+(?!\d))/g;

function expandedDecimal(value: number): string {
  const [mantissa, exponentText] = String(value).split('e');
  if (exponentText === undefined) return mantissa;
  const decimalIndex = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const point = (decimalIndex < 0 ? mantissa.length : decimalIndex) + Number(exponentText);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Defaults to the number's full decimal precision; explicit precision rounds display only. */
export function formatNumber(value: number, maximumFractionDigits?: number): string {
  if (!Number.isFinite(value)) throw new Error('Enter a finite number.');
  if (maximumFractionDigits !== undefined) {
    if (!Number.isInteger(maximumFractionDigits) || maximumFractionDigits < 0 || maximumFractionDigits > 20) {
      throw new Error('Display precision must be a whole number between zero and 20.');
    }
    const formatted = new Intl.NumberFormat('pt-BR', { maximumFractionDigits }).format(value);
    return /^-0(?:,0+)?$/.test(formatted) ? formatted.slice(1) : formatted;
  }
  const [whole, fraction] = expandedDecimal(Math.abs(value)).split('.');
  return `${value < 0 ? '-' : ''}${whole.replace(GROUP_INTEGER, '.')}${fraction === undefined ? '' : `,${fraction}`}`;
}

/** Formats integer cents without dividing through a floating-point currency amount. */
export function formatMoneyAmount(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error('Monetary amount is outside the supported range.');
  const absolute = BigInt(cents < 0 ? -cents : cents);
  const whole = String(absolute / 100n).replace(GROUP_INTEGER, '.');
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${whole},${fraction}`;
}

/** Commas mark decimals; valid dot grouping takes precedence over decimal-dot compatibility. */
export function parseLocalizedNumber(value: string): number {
  let text = value.trim();
  const sign = text.startsWith('-') ? '-' : '';
  if (/^[+-]/.test(text)) text = text.slice(1);
  let normalized: string;
  if (text.includes(',')) {
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)?,\d+$/.test(text)) throw new Error('Enter a valid number, such as 1.234,56.');
    normalized = text.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(text) && !/^0\./.test(text)) {
    normalized = text.replace(/\./g, '');
  } else if (/^(?:\d+|\d*\.\d+)$/.test(text)) {
    normalized = text;
  } else {
    throw new Error('Enter a valid number, such as 1.234,56.');
  }
  const parsed = Number(sign + normalized);
  if (!Number.isFinite(parsed)) throw new Error('Enter a finite number.');
  return parsed === 0 ? 0 : parsed;
}
