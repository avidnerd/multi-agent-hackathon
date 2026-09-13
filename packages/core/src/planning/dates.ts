const MS_PER_DAY = 86_400_000;

const dayMs = (isoDate: string): number => Date.parse(`${isoDate}T00:00:00Z`);

export const addDays = (isoDate: string, days: number): string => new Date(dayMs(isoDate) + days * MS_PER_DAY).toISOString().slice(0, 10);

export function datesInclusive(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let ms = dayMs(startDate); ms <= dayMs(endDate); ms += MS_PER_DAY) dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
}
