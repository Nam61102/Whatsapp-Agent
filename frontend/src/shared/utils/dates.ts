/**
 * A due date is a calendar day stored at UTC midnight. It is formatted in UTC so it never shifts
 * to the day before or after depending on the viewer's time zone.
 */
export const formatDueDate = (value: string | Date): string => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Recent';
  return 'Due ' + d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
