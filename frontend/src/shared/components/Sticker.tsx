import React from 'react';
import { Image, ImageStyle, StyleProp, View, StyleSheet } from 'react-native';

export type StickerName =
  | 'robot'
  | 'brain'
  | 'chat'
  | 'birthday'
  | 'calendar'
  | 'wallet'
  | 'travel'
  | 'qr'
  | 'friends'
  | 'empty';

const STICKER_SOURCES: Record<StickerName, any> = {
  robot: require('../../../assets/stickers/ai-robot.png'),
  brain: require('../../../assets/stickers/ai-brain.png'),
  chat: require('../../../assets/stickers/chat-bubbles.png'),
  birthday: require('../../../assets/stickers/birthday-cake.png'),
  calendar: require('../../../assets/stickers/calendar-meeting.png'),
  wallet: require('../../../assets/stickers/wallet-payment.png'),
  travel: require('../../../assets/stickers/travel-plane.png'),
  qr: require('../../../assets/stickers/qr-connect.png'),
  friends: require('../../../assets/stickers/friends-contacts.png'),
  empty: require('../../../assets/stickers/empty-relax.png'),
};

interface StickerProps {
  name: StickerName;
  size?: number;
  style?: StyleProp<ImageStyle>;
}

export const Sticker: React.FC<StickerProps> = ({ name, size = 100, style }) => {
  const source = STICKER_SOURCES[name] || STICKER_SOURCES.robot;

  return (
    <Image
      source={source}
      style={[
        {
          width: size,
          height: size,
          resizeMode: 'contain',
        },
        style,
      ]}
    />
  );
};
