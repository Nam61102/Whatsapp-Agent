import React from 'react';
import { View, Text, StyleSheet, StyleProp, TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface Props {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  style?: StyleProp<TextStyle>;
  size?: number;
  gap?: number;
  children: React.ReactNode;
  numberOfLines?: number;
  /** Centre the icon and text (for buttons). Default is left-aligned (for titles and labels). */
  center?: boolean;
}

/** An icon followed by text. The icon takes the colour and size of the text style. */
export const IconText = ({ icon, style, size, gap = 6, children, numberOfLines, center }: Props) => {
  const flat = StyleSheet.flatten(style) || {};
  const color = (flat.color as string) || '#0F172A';
  const fontSize = typeof flat.fontSize === 'number' ? flat.fontSize : 14;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: center ? 'center' : 'flex-start', gap }}>
      <Ionicons name={icon} size={size ?? Math.round(fontSize * 1.25)} color={color} />
      <Text style={style} numberOfLines={numberOfLines}>
        {children}
      </Text>
    </View>
  );
};
