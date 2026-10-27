import { Linking, Alert } from 'react-native';

export interface CalendarEventParams {
  title: string;
  description?: string;
  location?: string;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}

/**
 * Formats a Date into Google Calendar's required ISO-like format: YYYYMMDDTHHmmssZ
 */
function formatGCalDate(d: Date): string {
  return d.toISOString().replace(/-|:|\.\d\d\d/g, '');
}

/**
 * Generates an RFC-compliant Google Calendar template URL
 */
export function buildGoogleCalendarUrl(params: CalendarEventParams): string {
  const title = encodeURIComponent((params.title || 'WhatsApp Event').trim());
  const details = encodeURIComponent(
    ((params.description || '') + '\n\n[Synced automatically via WhatsApp AI Agent]').trim()
  );
  const location = encodeURIComponent((params.location || '').trim());

  let start = params.startDate ? new Date(params.startDate) : new Date(Date.now() + 60 * 60 * 1000);
  if (isNaN(start.getTime())) {
    start = new Date(Date.now() + 60 * 60 * 1000);
  }

  let end = params.endDate ? new Date(params.endDate) : new Date(start.getTime() + 60 * 60 * 1000);
  if (isNaN(end.getTime()) || end <= start) {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }

  const dateStr = `${formatGCalDate(start)}/${formatGCalDate(end)}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dateStr}&details=${details}&location=${location}`;
}

/**
 * Opens Google Calendar directly via Android Intent / Deep Link / Browser
 */
export async function openGoogleCalendar(params: CalendarEventParams): Promise<boolean> {
  try {
    const url = buildGoogleCalendarUrl(params);
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
      return true;
    } else {
      await Linking.openURL(url);
      return true;
    }
  } catch (err: any) {
    Alert.alert('Calendar Error', 'Could not open Google Calendar on this device.');
    return false;
  }
}
