import { create } from "zustand";
import type { ReviewItem, DeadZoneAlert } from "@kemple/shared";

interface KempleStore {
  // Connection
  connected: boolean;
  setConnected: (v: boolean) => void;

  // Queue
  items: (ReviewItem & { isHolding?: boolean })[];
  processedItems: ReviewItem[];
  setItems: (items: ReviewItem[]) => void;
  addItem: (item: ReviewItem) => void;
  removeItem: (clusterId: string, toProcessed?: boolean) => void;
  setHold: (clusterId: string, isHolding: boolean) => void;

  // Selection
  selectedId: string | null;
  setSelected: (id: string | null) => void;

  // Dead Zones
  deadZones: DeadZoneAlert[];
  addDeadZone: (z: DeadZoneAlert) => void;

  // Stats
  totalProcessed: number;
  totalCarriedData: number;
  incrementProcessed: () => void;

  // Map fly-to
  flyTo: { lat: number; lng: number; zoom: number } | null;
  setFlyTo: (coords: { lat: number; lng: number; zoom: number } | null) => void;
}

export const useKemple = create<KempleStore>((set) => ({
  connected: false,
  setConnected: (v) => set({ connected: v }),

  items: [],
  processedItems: [],
  setItems: (items) => 
    set(() => {
      const unique = Array.from(new Map(items.map(i => [i.cluster_id, i])).values());
      return { items: unique };
    }),
  totalCarriedData: 0,
  addItem: (item) =>
    set((s) => {
      const existing = s.items.find((i) => i.cluster_id === item.cluster_id);
      const isProcessed = s.processedItems.some(i => i.cluster_id === item.cluster_id);
      
      // Eğer zaten işlem görmüşse kuyruğa ekleme
      if (isProcessed) return s;

      const diff = existing ? (item.source_count - existing.source_count) : item.source_count;
      
      return {
        items: existing
          ? s.items.map((i) => (i.cluster_id === item.cluster_id ? { ...item, isHolding: i.isHolding } : i))
          : [item, ...s.items],
        totalProcessed: existing ? s.totalProcessed : s.totalProcessed + 1,
        totalCarriedData: s.totalCarriedData + diff,
      };
    }),
  setHold: (clusterId, isHolding) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.cluster_id === clusterId ? { ...i, isHolding } : i
      ),
    })),
  removeItem: (clusterId, toProcessed = false) =>
    set((s) => {
      const itemToMove = s.items.find(i => i.cluster_id === clusterId);
      return {
        items: s.items.filter((i) => i.cluster_id !== clusterId),
        processedItems: (toProcessed && itemToMove) 
          ? [itemToMove, ...s.processedItems].slice(0, 50) 
          : s.processedItems
      };
    }),

  selectedId: null,
  setSelected: (id) => set({ selectedId: id }),

  deadZones: [],
  addDeadZone: (z) =>
    set((s) => ({
      deadZones: s.deadZones.some((d) => d.grid_cell_id === z.grid_cell_id)
        ? s.deadZones
        : [...s.deadZones, z],
    })),

  totalProcessed: 0,
  incrementProcessed: () => set((s) => ({ totalProcessed: s.totalProcessed + 1 })),

  flyTo: null,
  setFlyTo: (coords) => set({ flyTo: coords }),
}));
