// The width estimate of a select option, the JavaScript twin of optionUnits() in mod/mcm.lua (see the comment there).
export function optionUnits(text) {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 0x10000) units += 2;
    else if (code >= 0x2E80) units += 2;
    else if (code >= 0x800) units += char === '’' ? 0.45 : 1;
    else if (code >= 0x80) units += char === '·' ? 0.65 : 1.05;
    else if (char === ' ') units += 0.5;
    else if ("il.,:;'|!".includes(char)) units += 0.45;
    else if ('tfrI()-/[]'.includes(char)) units += 0.65;
    else if (char === 'm' || char === 'w') units += 1.45;
    else if (char === 'M' || char === 'W') units += 1.6;
    else if (/[A-Z0-9]/.test(char)) units += 1.15;
    else units += 1;
  }
  return Math.round(units * 10) / 10;
}
