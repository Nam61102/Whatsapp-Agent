import React from 'react';
import { View, StyleSheet, StyleProp, ViewStyle, ImageStyle } from 'react-native';
import { Sticker, StickerName } from './Sticker';

export type IllustrationName =
  | 'chat'
  | 'ai'
  | 'contacts'
  | 'done'
  | 'link'
  | 'robot'
  | 'brain'
  | 'birthday'
  | 'calendar'
  | 'wallet'
  | 'travel'
  | 'qr'
  | 'friends'
  | 'empty';

const NAME_MAP: Record<IllustrationName, StickerName> = {
  chat: 'chat',
  ai: 'robot',
  contacts: 'friends',
  done: 'empty',
  link: 'qr',
  robot: 'robot',
  brain: 'brain',
  birthday: 'birthday',
  calendar: 'calendar',
  wallet: 'wallet',
  travel: 'travel',
  qr: 'qr',
  friends: 'friends',
  empty: 'empty',
};

interface IllustrationProps {
  name: IllustrationName;
  size?: number;
  containerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ImageStyle>;
}

export const Illustration: React.FC<IllustrationProps> = ({
  name,
  size = 180,
  containerStyle,
  style,
}) => {
  const stickerName = NAME_MAP[name] || 'robot';

  return (
    <View style={[styles.wrapper, containerStyle]}>
      <Sticker name={stickerName} size={size} style={style} />
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
