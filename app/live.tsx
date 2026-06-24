import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, FlatList, StyleSheet, ActivityIndicator, Modal, useTVEventHandler, HWEvent, Text, Alert } from "react-native";
import LivePlayer from "@/components/LivePlayer";
import { fetchAndParseM3u, getPlayableUrl, Channel } from "@/services/m3u";
import { ThemedView } from "@/components/ThemedView";
import { StyledButton } from "@/components/StyledButton";
import { api } from "@/services/api";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";
import Toast from "react-native-toast-message";
import Logger from "@/utils/Logger";
import useAuthStore from "@/stores/authStore";

const logger = Logger.withTag('Live');

// 验活：HEAD 请求，超时 3 秒
async function checkLiveSource(url: string): Promise<{ alive: boolean; latency: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);
    return { alive: response.ok, latency: Date.now() - start };
  } catch {
    return { alive: false, latency: Infinity };
  }
}

export default function LiveScreen() {
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;
  const { isLoggedIn } = useAuthStore();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [groupedChannels, setGroupedChannels] = useState<Record<string, Channel[]>>({});
  const [channelGroups, setChannelGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isChannelListVisible, setIsChannelListVisible] = useState(false);
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  const titleTimer = useRef<NodeJS.Timeout | null>(null);

  const selectedChannelUrl = channels.length > 0 ? getPlayableUrl(channels[currentChannelIndex].url) : null;

  const showChannelTitle = useCallback((title: string) => {
    setChannelTitle(title);
    if (titleTimer.current) {
      clearTimeout(titleTimer.current);
    }
    titleTimer.current = setTimeout(() => setChannelTitle(null), 3000);
  }, []);

  // 自动获取直播源 → 验活 → 选延迟最低的 → 解析 M3U
  useEffect(() => {
    const loadChannels = async () => {
      setIsLoading(true);
      try {
        const result = await api.getLiveSources();
        const sources = (result.data || []).filter(s => !s.disabled && s.url);
        if (sources.length === 0) {
          Alert.alert("提示", "没有可用的直播源");
          setIsLoading(false);
          return;
        }

        const checks = await Promise.all(
          sources.map(async (source) => {
            const { alive, latency } = await checkLiveSource(source.url);
            return { ...source, alive, latency };
          })
        );

        const aliveSources = checks.filter(s => s.alive).sort((a, b) => a.latency - b.latency);
        if (aliveSources.length === 0) {
          Alert.alert("提示", "直播源不可用，请稍后重试");
          setIsLoading(false);
          return;
        }

        const bestSource = aliveSources[0];
        logger.info(`Selected live source: ${bestSource.name} (latency: ${bestSource.latency}ms)`);
        Toast.show({ type: "info", text1: `使用直播源: ${bestSource.name}`, text2: `延迟 ${bestSource.latency}ms` });

        const parsedChannels = await fetchAndParseM3u(bestSource.url);
        setChannels(parsedChannels);

        const groups: Record<string, Channel[]> = parsedChannels.reduce((acc, channel) => {
          const groupName = channel.group || "Other";
          if (!acc[groupName]) acc[groupName] = [];
          acc[groupName].push(channel);
          return acc;
        }, {} as Record<string, Channel[]>);

        const groupNames = Object.keys(groups);
        setGroupedChannels(groups);
        setChannelGroups(groupNames);
        setSelectedGroup(groupNames[0] || "");

        if (parsedChannels.length > 0) {
          showChannelTitle(parsedChannels[0].name);
        }
      } catch (error) {
        logger.error("Failed to load live sources:", error);
        Toast.show({ type: "error", text1: "获取直播源失败" });
      } finally {
        setIsLoading(false);
      }
    };
    loadChannels();
  }, [showChannelTitle, isLoggedIn]);

  const handleSelectChannel = useCallback((channel: Channel) => {
    const globalIndex = channels.findIndex((c) => c.id === channel.id);
    if (globalIndex !== -1) {
      setCurrentChannelIndex(globalIndex);
      showChannelTitle(channel.name);
      setIsChannelListVisible(false);
    }
  }, [channels, showChannelTitle]);

  const changeChannel = useCallback(
    (direction: "next" | "prev") => {
      if (channels.length === 0) return;
      const newIndex = direction === "next"
        ? (currentChannelIndex + 1) % channels.length
        : (currentChannelIndex - 1 + channels.length) % channels.length;
      setCurrentChannelIndex(newIndex);
      showChannelTitle(channels[newIndex].name);
    },
    [channels, currentChannelIndex, showChannelTitle]
  );

  const handleTVEvent = useCallback(
    (event: HWEvent) => {
      if (deviceType !== 'tv') return;
      if (isChannelListVisible) return;
      if (event.eventType === "down") setIsChannelListVisible(true);
      else if (event.eventType === "left") changeChannel("prev");
      else if (event.eventType === "right") changeChannel("next");
    },
    [changeChannel, isChannelListVisible, deviceType]
  );

  useTVEventHandler(deviceType === 'tv' ? handleTVEvent : () => {});

  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderLiveContent = () => (
    <>
      <LivePlayer 
        streamUrl={selectedChannelUrl} 
        channelTitle={channelTitle} 
        onPlaybackStatusUpdate={() => {}} 
      />
      <Modal
        animationType="slide"
        transparent={true}
        visible={isChannelListVisible}
        onRequestClose={() => setIsChannelListVisible(false)}
      >
        <View style={dynamicStyles.modalContainer}>
          <View style={dynamicStyles.modalContent}>
            <Text style={dynamicStyles.modalTitle}>选择频道</Text>
            <View style={dynamicStyles.listContainer}>
              <View style={dynamicStyles.groupColumn}>
                <FlatList
                  data={channelGroups}
                  keyExtractor={(item, index) => `group-${item}-${index}`}
                  renderItem={({ item }) => (
                    <StyledButton
                      text={item}
                      onPress={() => setSelectedGroup(item)}
                      isSelected={selectedGroup === item}
                      style={dynamicStyles.groupButton}
                      textStyle={dynamicStyles.groupButtonText}
                    />
                  )}
                />
              </View>
              <View style={dynamicStyles.channelColumn}>
                {isLoading ? (
                  <ActivityIndicator size="large" />
                ) : (
                  <FlatList
                    data={groupedChannels[selectedGroup] || []}
                    keyExtractor={(item, index) => `${item.id}-${item.group}-${index}`}
                    renderItem={({ item }) => (
                      <StyledButton
                        text={item.name || "Unknown Channel"}
                        onPress={() => handleSelectChannel(item)}
                        isSelected={channels[currentChannelIndex]?.id === item.id}
                        hasTVPreferredFocus={channels[currentChannelIndex]?.id === item.id}
                        style={dynamicStyles.channelItem}
                        textStyle={dynamicStyles.channelItemText}
                      />
                    )}
                  />
                )}
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderLiveContent()}
    </ThemedView>
  );

  if (deviceType === 'tv') return content;

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="直播" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: { flex: 1 },
    modalContainer: {
      flex: 1,
      flexDirection: "row",
      justifyContent: isMobile ? "center" : "flex-end",
      backgroundColor: "transparent",
    },
    modalContent: {
      width: isMobile ? '90%' : isTablet ? 400 : 450,
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
      padding: spacing,
    },
    modalTitle: {
      color: "white",
      marginBottom: spacing / 2,
      textAlign: "center",
      fontSize: isMobile ? 18 : 16,
      fontWeight: "bold",
    },
    listContainer: { flex: 1, flexDirection: isMobile ? "column" : "row" },
    groupColumn: {
      flex: isMobile ? 0 : 1,
      marginRight: isMobile ? 0 : spacing / 2,
      marginBottom: isMobile ? spacing : 0,
      maxHeight: isMobile ? 120 : undefined,
    },
    channelColumn: { flex: isMobile ? 1 : 2 },
    groupButton: {
      paddingVertical: isMobile ? minTouchTarget / 4 : 8,
      paddingHorizontal: spacing / 2,
      marginVertical: isMobile ? 2 : 4,
      minHeight: isMobile ? minTouchTarget * 0.7 : undefined,
    },
    groupButtonText: { fontSize: isMobile ? 14 : 13 },
    channelItem: {
      paddingVertical: isMobile ? minTouchTarget / 5 : 6,
      paddingHorizontal: spacing,
      marginVertical: isMobile ? 2 : 3,
      minHeight: isMobile ? minTouchTarget * 0.8 : undefined,
    },
    channelItemText: { fontSize: isMobile ? 14 : 12 },
  });
};
