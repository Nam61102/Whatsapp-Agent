import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { AuthStorage } from '../../shared/services/authStorage';
import { socketService } from '../../shared/services/socket';
import { loadDeviceContacts } from '../../shared/services/deviceContacts';
import { Ionicons } from '@expo/vector-icons';
import { Sticker } from '../../shared/components/Sticker';

export const LoginScreen = ({ navigation }: any) => {
  const [email, setEmail] = useState('demo@user.com');
  const [password, setPassword] = useState('password123');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response: any = await apiClient.post('/auth/login', {
        email: email.trim(),
        password,
      });

      await AuthStorage.setToken(response.accessToken);
      await AuthStorage.setUser(response.user);
      socketService.connect();
      loadDeviceContacts().catch(() => {});

      if (response.user.whatsappAccount?.status === 'CONNECTED') {
        navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
      } else {
        navigation.reset({ index: 0, routes: [{ name: 'WhatsAppConnect' }] });
      }
    } catch (err: any) {
      setError(err.message || 'Login failed. Please check credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Animated 2D Cartoon Hero Header */}
        <View style={styles.header}>
          <View style={styles.stickerWrapper}>
            <Sticker name="robot" size={135} />
            <View style={styles.speechBubble}>
              <Text style={styles.speechText}>Hi! I'm your WhatsApp AI 🤖</Text>
              <View style={styles.speechTail} />
            </View>
          </View>
          <Text style={styles.appTitle}>WhatsApp AI Assistant</Text>
          <Text style={styles.subtitle}>Smart real-time chat & memory intelligence</Text>

          {/* Feature highlights pill row */}
          <View style={styles.featureRow}>
            <View style={styles.featurePill}>
              <Text style={styles.featurePillText}>⚡ Live Sync</Text>
            </View>
            <View style={[styles.featurePill, { backgroundColor: '#F3E8FF', borderColor: '#E9D5FF' }]}>
              <Text style={[styles.featurePillText, { color: '#7E22CE' }]}>🧠 Gemini AI</Text>
            </View>
            <View style={[styles.featurePill, { backgroundColor: '#DCFCE7', borderColor: '#BBF7D0' }]}>
              <Text style={[styles.featurePillText, { color: '#15803D' }]}>🔒 Private</Text>
            </View>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.formTitle}>Sign In to Your Workspace</Text>

          {error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={18} color={Colors.danger} style={{ marginRight: 6 }} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Text style={styles.label}>Email Address</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="mail-outline" size={19} color={Colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="name@example.com"
              placeholderTextColor={Colors.textLight}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          <Text style={styles.label}>Password</Text>
          <View style={styles.inputContainer}>
            <Ionicons name="lock-closed-outline" size={19} color={Colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={Colors.textLight}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <View style={styles.btnInner}>
                <Text style={styles.buttonText}>Log In to Assistant</Text>
                <Ionicons name="arrow-forward" size={18} color="#FFF" style={{ marginLeft: 6 }} />
              </View>
            )}
          </TouchableOpacity>

          <View style={styles.footerRow}>
            <Text style={styles.footerText}>Don't have an account? </Text>
            <TouchableOpacity onPress={() => navigation.navigate('Register')}>
              <Text style={styles.linkText}>Create Account</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 22,
    paddingVertical: 36,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  stickerWrapper: {
    alignItems: 'center',
    marginBottom: 8,
    position: 'relative',
  },
  speechBubble: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: Colors.secondary,
    position: 'absolute',
    top: 4,
    right: -24,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  speechText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
  },
  speechTail: {
    position: 'absolute',
    bottom: -6,
    left: 14,
    width: 10,
    height: 6,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: Colors.secondary,
  },
  appTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.text,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 4,
    textAlign: 'center',
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
  },
  featurePill: {
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CCEBE5',
  },
  featurePillText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.primary,
  },
  card: {
    backgroundColor: Colors.cardBackground,
    borderRadius: 22,
    padding: 24,
    shadowColor: '#075E54',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  formTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 18,
    textAlign: 'center',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginBottom: 6,
    marginTop: 12,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 15,
    color: Colors.text,
  },
  primaryButton: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 24,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  btnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  buttonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FEE2E2',
    padding: 12,
    borderRadius: 10,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  errorText: {
    color: Colors.danger,
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 22,
  },
  footerText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  linkText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.secondary,
  },
});
