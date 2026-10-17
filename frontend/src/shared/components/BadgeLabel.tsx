import React from 'react';
import { Text, View, StyleProp, TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Card labels arrive from the server as "<emoji> Text". Emoji look different on every phone, so the leading
 * emoji is replaced by one vector icon from the same set as the rest of the app.
 */
const ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  '🎂': 'gift', '🎉': 'gift', '📅': 'calendar', '✅': 'checkmark-circle', '🔄': 'repeat', '⏰': 'alarm', '⏳': 'hourglass',
  '💰': 'cash', '✈️': 'airplane', '⭐': 'star', '🤝': 'people', '👤': 'person', '💼': 'briefcase', '❓': 'help-circle',
  '🧾': 'receipt', '📦': 'cube', '📄': 'document-text', '⚠️': 'warning', '🚨': 'alert-circle', '📝': 'create',
  '🎯': 'locate', '📈': 'trending-up', '🔀': 'swap-horizontal', '📌': 'pin', '🧑‍💼': 'person', '🔁': 'repeat',
  '✔️': 'checkmark-done', '♻️': 'refresh', '🏁': 'flag', '🗒️': 'reader', '⚡': 'flash', '🔔': 'notifications',
};

export const splitLabel = (label: string): { icon: React.ComponentProps<typeof Ionicons>['name'] | null; text: string } => {
  const text = (label || '').trim();
  for (const [emoji, icon] of Object.entries(ICONS)) {
    if (text.startsWith(emoji)) return { icon, text: text.slice(emoji.length).trim() };
  }
  // an emoji we do not know: drop it rather than show a symbol that looks different on every phone
  const stripped = text.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '');
  return { icon: null, text: stripped || text };
};

export const BadgeLabel = ({ label, color, style }: { label: string; color: string; style?: StyleProp<TextStyle> }) => {
  const { icon, text } = splitLabel(label);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {icon && <Ionicons name={icon} size={14} color={color} />}
      <Text style={[{ color }, style]}>{text}</Text>
    </View>
  );
};
