export function pad(num: number, base: number, size: number) {
    let numString = num.toString(base);
    while (numString.length < size) numString = '0' + numString;
    return numString;
}
