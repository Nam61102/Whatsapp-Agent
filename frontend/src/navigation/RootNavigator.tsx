import React, { useState, useEffect } from 'react';
import { NavigationContainer, getFocusedRouteNameFromRoute, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { Text, View, StyleSheet, ActivityIndicator, Platform, Alert } from 'react-native';

export const navigationRef = createNavigationContainerRef<any>();

import { LoginScreen } from '../features/auth/LoginScreen';
import { RegisterScreen } from '../features/auth/RegisterScreen';
import { WhatsAppConnectScreen } from '../features/whatsapp/WhatsAppConnectScreen';
import { DashboardScreen } from '../features/dashboard/DashboardScreen';
import { ChatListScreen } from '../features/chats/ChatListScreen';
import { ChatDetailScreen } from '../features/chats/ChatDetailScreen';
import { ContactListScreen } from '../features/contacts/ContactListScreen';
import { ContactProfileScreen } from '../features/contacts/ContactProfileScreen';
import { ExtractionsScreen } from '../features/extractions/ExtractionsScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { Colors } from '../shared/theme/colors';
import { AuthStorage } from '../shared/services/authStorage';
import { socketService } from '../shared/services/socket';
import { apiClient } from '../shared/services/api';
import { loadDeviceContacts } from '../shared/services/deviceContacts';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
const ChatsStack = createNativeStackNavigator();
const ContactsStack = createNativeStackNavigator();

function ChatsNavigator() {
  return (
    <ChatsStack.Navigator
      id="chats-stack"
      screenOptions={{
        headerStyle: { backgroundColor: Colors.primary },
        headerTintColor: '#FFF',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <ChatsStack.Screen
        name="ChatList"
        component={ChatListScreen}
        options={{ title: 'WhatsApp Chats' }}
      />
      <ChatsStack.Screen
        name="ChatDetail"
        component={ChatDetailScreen}
        options={{ headerShown: false }}
      />
    </ChatsStack.Navigator>
  );
}

function ContactsNavigator() {
  return (
    <ContactsStack.Navigator
      id="contacts-stack"
      screenOptions={{
        headerStyle: { backgroundColor: Colors.primary },
        headerTintColor: '#FFF',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <ContactsStack.Screen
        name="ContactList"
        component={ContactListScreen}
        options={{ title: 'Contacts' }}
      />
      <ContactsStack.Screen
        name="ContactProfile"
        component={ContactProfileScreen}
        options={{ title: 'Likes & Dislikes' }}
      />
    </ContactsStack.Navigator>
  );
}

function MainTabNavigator() {
  return (
    <Tab.Navigator
      id="main-tabs"
      screenOptions={({ route }) => {
        const routeName = getFocusedRouteNameFromRoute(route) ?? '';
        const isChatDetail = routeName === 'ChatDetail';

        return {
          headerStyle: { backgroundColor: Colors.primary },
          headerTintColor: '#FFF',
          headerTitleStyle: { fontWeight: '700' },
          tabBarActiveTintColor: Colors.primary,
          tabBarInactiveTintColor: Colors.textMuted,
          tabBarStyle: isChatDetail
            ? { display: 'none' }
            : {
                backgroundColor: '#FFFFFF',
                borderTopColor: '#E2E8F0',
                borderTopWidth: 1,
                height: Platform.OS === 'ios' ? 84 : 72,
                paddingBottom: Platform.OS === 'ios' ? 22 : 10,
                paddingTop: 8,
                elevation: 8,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: -2 },
                shadowOpacity: 0.06,
                shadowRadius: 4,
              },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '600',
            marginTop: 0,
          },
          tabBarIcon: ({ focused, color }) => {
            // Each tab has its own icon (Dashboard and Action Center used to share one emoji).
            const names: Record<string, [any, any]> = {
              DashboardTab: ['grid', 'grid-outline'],
              ChatsTab: ['chatbubbles', 'chatbubbles-outline'],
              ContactsTab: ['people', 'people-outline'],
              ExtractionsTab: ['flash', 'flash-outline'],
              SettingsTab: ['settings', 'settings-outline'],
            };
            const [on, off] = names[route.name] || ['ellipse', 'ellipse-outline'];
            return (
              <View style={[styles.iconBox, focused && styles.iconBoxFocused]}>
                <Ionicons name={focused ? on : off} size={22} color={color} />
              </View>
            );
          },
        };
      }}
    >
      <Tab.Screen
        name="DashboardTab"
        component={DashboardScreen}
        options={{ title: 'Dashboard', tabBarLabel: 'Dashboard' }}
      />
      <Tab.Screen
        name="ChatsTab"
        component={ChatsNavigator}
        options={{ headerShown: false, tabBarLabel: 'Chats' }}
      />
      <Tab.Screen
        name="ContactsTab"
        component={ContactsNavigator}
        options={{ headerShown: false, tabBarLabel: 'Contacts' }}
      />
      <Tab.Screen
        name="ExtractionsTab"
        component={ExtractionsScreen}
        options={{ title: 'Action Center', tabBarLabel: 'Action Center' }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsScreen}
        options={{ title: 'Settings', tabBarLabel: 'Settings' }}
      />
    </Tab.Navigator>
  );
}

export const RootNavigator = () => {
  const [initialRoute, setInitialRoute] = useState<string | null>(null);

  useEffect(() => {
    async function initAuth() {
      try {
        const hasAuth = await AuthStorage.init();
        if (hasAuth && AuthStorage.getToken()) {
          socketService.connect();
          // Fire-and-forget: load device address book so chat/contact names match the mobile phonebook.
          loadDeviceContacts().catch(() => {});
          let user = AuthStorage.getUser();
          // Open straight away from what is saved on the device. The server is slow to answer from far away
          // (and sleeps when idle), so the screen must not wait for it. Only a 401 means the login is invalid.
          if (user) {
            const cachedConnected = ['CONNECTED', 'READY', 'SYNCING'].includes(user?.whatsappAccount?.status);
            setInitialRoute(cachedConnected ? 'Main' : 'WhatsAppConnect');
            apiClient
              .get('/auth/me')
              .then((me: any) => me && AuthStorage.setUser(me))
              .catch(async (e: any) => {
                if (e?.statusCode === 401) {
                  await AuthStorage.clear();
                  if (navigationRef.isReady()) navigationRef.reset({ index: 0, routes: [{ name: 'Login' }] });
                }
              });
            return;
          }
          try {
            const me: any = await apiClient.get('/auth/me');
            if (me) {
              user = me;
              await AuthStorage.setUser(me);
            }
          } catch (e: any) {
            if (e?.statusCode === 401) {
              await AuthStorage.clear();
              setInitialRoute('Login');
              return;
            }
          }

          // Check real-time WhatsApp status from backend rather than stale cached field
          let waConnected = false;
          let alreadyOnOtherDevice = false;
          try {
            const statusRes: any = await apiClient.get('/whatsapp/status');
            if (statusRes?.alreadyConnectedOnOtherDevice) {
              alreadyOnOtherDevice = true;
            } else if (
              statusRes.status === 'CONNECTED' ||
              statusRes.status === 'READY' ||
              statusRes.status === 'SYNCING'
            ) {
              waConnected = true;
            }
          } catch {}

          if (alreadyOnOtherDevice) {
            // Another device has the connection! Direct this device to WhatsAppConnect screen to see warning
            setInitialRoute('WhatsAppConnect');
          } else if (waConnected || user?.whatsappAccount?.status === 'CONNECTED' || user?.whatsappAccount?.status === 'SYNCING') {
            setInitialRoute('Main');
          } else {
            setInitialRoute('WhatsAppConnect');
          }
        } else {
          setInitialRoute('Login');
        }
      } catch {
        setInitialRoute('Login');
      }
    }
    initAuth();

    // Listen for session takeover from another device
    const unsubTakeover = socketService.on('whatsapp.session_taken_over', (data: any) => {
      const msg =
        data?.message ||
        'Your WhatsApp connection was disconnected because another device logged in and took over the connection.';
      if (Platform.OS === 'web') {
        window.alert(`[WhatsApp Session Disconnected]\n\n${msg}`);
      } else {
        Alert.alert('WhatsApp Session Disconnected', msg);
      }
      if (navigationRef.isReady()) {
        navigationRef.reset({ index: 0, routes: [{ name: 'WhatsAppConnect' }] });
      }
    });

    return () => {
      unsubTakeover();
    };
  }, []);

  if (initialRoute === null) {
    return (
      <View style={styles.splashContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator
        id="root-stack"
        initialRouteName={initialRoute}
        screenOptions={{
          headerStyle: { backgroundColor: Colors.primary },
          headerTintColor: '#FFF',
          headerTitleStyle: { fontWeight: '700' },
        }}
      >
        <Stack.Screen
          name="Login"
          component={LoginScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Register"
          component={RegisterScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="WhatsAppConnect"
          component={WhatsAppConnectScreen}
          options={{ title: 'Connect WhatsApp' }}
        />
        <Stack.Screen
          name="Main"
          component={MainTabNavigator}
          options={{ headerShown: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
};

const styles = StyleSheet.create({
  splashContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.background,
  },
  iconBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 16,
  },
  iconBoxFocused: {
    backgroundColor: '#E8F5F2',
  },
});
