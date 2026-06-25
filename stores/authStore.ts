import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "@/services/api";
import { LoginCredentialsManager } from "@/services/storage";
import { useSettingsStore } from "./settingsStore";
import Toast from "react-native-toast-message";
import Logger from "@/utils/Logger";

const logger = Logger.withTag('AuthStore');

/**
 * 尝试自动登录：
 * - localstorage 模式：直接调 api.login()（服务器用 env PASSWORD 校验）
 * - DB 模式：用 LoginCredentialsManager 保存的凭据登录
 */
const attemptAutoLogin = async (storageType: string): Promise<boolean> => {
  if (storageType === "localstorage") {
    try {
      const result = await api.login();
      return !!result?.ok;
    } catch {
      return false;
    }
  }
  const credentials = await LoginCredentialsManager.get();
  if (!credentials) return false;
  try {
    const result = await api.login(credentials.username, credentials.password);
    return !!result?.ok;
  } catch {
    return false;
  }
};

interface AuthState {
  isLoggedIn: boolean;
  isLoginModalVisible: boolean;
  showLoginModal: () => void;
  hideLoginModal: () => void;
  checkLoginStatus: (apiBaseUrl?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const useAuthStore = create<AuthState>((set) => ({
  isLoggedIn: false,
  isLoginModalVisible: false,
  showLoginModal: () => set({ isLoginModalVisible: true }),
  hideLoginModal: () => set({ isLoginModalVisible: false }),
  checkLoginStatus: async (apiBaseUrl?: string) => {
    if (!apiBaseUrl) {
      set({ isLoggedIn: false, isLoginModalVisible: false });
      return;
    }
    try {
      // Wait for server config to be loaded if it's currently loading
      const settingsState = useSettingsStore.getState();
      let serverConfig = settingsState.serverConfig;

      // If server config is loading, wait a bit for it to complete
      if (settingsState.isLoadingServerConfig) {
        // Wait up to 3 seconds for server config to load
        const maxWaitTime = 3000;
        const checkInterval = 100;
        let waitTime = 0;

        while (waitTime < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          waitTime += checkInterval;
          const currentState = useSettingsStore.getState();
          if (!currentState.isLoadingServerConfig) {
            serverConfig = currentState.serverConfig;
            break;
          }
        }
      }

      if (!serverConfig?.StorageType) {
        // Only show error if we're not loading and have tried to fetch the config
        // if (!settingsState.isLoadingServerConfig) {
        //   Toast.show({ type: "error", text1: "请检查网络或者服务器地址是否可用" });
        // }
        return;
      }

      const authToken = await AsyncStorage.getItem('authCookies');
      if (!authToken) {
        // 无 token：尝试自动登录
        const success = await attemptAutoLogin(serverConfig.StorageType);
        set({ isLoggedIn: success, isLoginModalVisible: !success });
      } else {
        // 有 token：验证有效性而非盲目认为已登录
        const refreshed = await api.tryRefresh();
        if (refreshed) {
          set({ isLoggedIn: true, isLoginModalVisible: false });
        } else {
          // token 失效，清除旧 token 并尝试自动重登
          await AsyncStorage.setItem('authCookies', '');
          const success = await attemptAutoLogin(serverConfig.StorageType);
          set({ isLoggedIn: success, isLoginModalVisible: !success });
        }
      }
    } catch (error) {
      logger.error("Failed to check login status:", error);
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        set({ isLoggedIn: false, isLoginModalVisible: true });
      } else {
        set({ isLoggedIn: false });
      }
    }
  },
  logout: async () => {
    try {
      await api.logout();
      set({ isLoggedIn: false, isLoginModalVisible: true });
    } catch (error) {
      logger.error("Failed to logout:", error);
    }
  },
}));

export default useAuthStore;
