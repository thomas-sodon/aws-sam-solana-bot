export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const getElapsedTime = (startTime: Date): number => {
    const endTime = new Date();
    const elapsed = (endTime.getTime() - startTime.getTime()) / 1000;
    return elapsed;
};

export const getErrorObject = (error: any, removeStack?: boolean): Record<string, string> =>
    Object.getOwnPropertyNames(error).reduce((acc, curr) => {
        if (curr === 'stack' && removeStack) return acc;
        acc[curr] = error[curr];
        return acc;
    }, {} as any);

export const shuffleArray = (array: any[]): any[] => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};
