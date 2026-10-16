import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Colors } from '../theme/colors';

interface SyncProgressBarProps {
  progress: number;
  stage?: string;
  message?: string;
  status?: string;
}

export const SyncProgressBar: React.FC<SyncProgressBarProps> = ({
  progress,
  stage = 'SYNCING',
  message,
  status = 'SYNCING',
}) => {
  const isCompleted = status === 'COMPLETED' || progress >= 100;
  const clampedProgress = Math.min(100, Math.max(0, Math.round(progress)));

  const displayMessage =
    message ||
    (isCompleted
      ? 'WhatsApp Synchronization Complete!'
      : `Synchronizing WhatsApp ${stage.toLowerCase()} (${clampedProgress}%)...`);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.statusGroup}>
          {!isCompleted ? (
            <ActivityIndicator size="small" color="#FFFFFF" style={styles.spinner} />
          ) : (
            <Text style={styles.checkIcon}>✓</Text>
          )}
          <Text style={styles.messageText} numberOfLines={1}>
            {displayMessage}
          </Text>
        </View>
        <Text style={styles.percentageText}>{clampedProgress}%</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.bar, { width: `${clampedProgress}%` }]} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.primaryDark,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginVertical: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  statusGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  spinner: {
    marginRight: 8,
  },
  checkIcon: {
    color: '#34D399',
    fontSize: 14,
    fontWeight: '800',
    marginRight: 6,
  },
  messageText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  percentageText: {
    color: '#34D399',
    fontSize: 13,
    fontWeight: '700',
  },
  track: {
    height: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
    backgroundColor: '#34D399',
    borderRadius: 3,
  },
});
