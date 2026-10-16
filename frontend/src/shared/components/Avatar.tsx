import React, { useState } from 'react';
import { View, Text, Image, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// Soft background + strong initial, picked from the name so a person always gets the same colour.
const TONES: Array<[string, string]> = [
  ['#DBEAFE', '#1D4ED8'],
  ['#DCFCE7', '#15803D'],
  ['#FCE7F3', '#BE185D'],
  ['#FFEDD5', '#C2410C'],
  ['#EDE9FE', '#6D28D9'],
  ['#CCFBF1', '#0F766E'],
  ['#FEF9C3', '#A16207'],
  ['#E0E7FF', '#4338CA'],
];

const toneFor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
};

interface Props {
  name?: string | null;
  uri?: string | null;
  size?: number;
  group?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** The person's WhatsApp photo, or coloured initials (people icon for groups) when there is none. */
export const Avatar = ({ name, uri, size = 44, group = false, style }: Props) => {
  const [failed, setFailed] = useState(false);
  const label = (name || '').trim();
  const [bg, fg] = group ? ['#E2E8F0', '#475569'] : toneFor(label || '?');
  const base: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: bg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };

  if (uri && !failed) {
    return (
      <View style={[base, style]}>
        <Image source={{ uri }} style={{ width: size, height: size }} onError={() => setFailed(true)} />
      </View>
    );
  }
  return (
    <View style={[base, style]}>
      {group ? (
        <Ionicons name="people" size={Math.round(size * 0.5)} color={fg} />
      ) : (
        <Text style={{ color: fg, fontSize: Math.round(size * 0.42), fontWeight: '800' }}>
          {(label.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase()}
        </Text>
      )}
    </View>
  );
};
