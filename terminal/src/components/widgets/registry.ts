import type { ComponentType } from "react";
import type { WidgetType } from "@/lib/state/workspace";
import ChartWidget, { type WidgetProps } from "./ChartWidget";
import OrderFlowMatrix from "./OrderFlowMatrix";
import MoneyFlowProfile from "./MoneyFlowProfile";
import OptionChain from "./OptionChain";
import DomLadder from "./DomLadder";
import PowerScanner from "./PowerScanner";
import HighLowScanner from "./HighLowScanner";
import Watchlist from "./Watchlist";
import MediaPanel from "./MediaPanel";

export const WIDGETS: Record<WidgetType, ComponentType<WidgetProps>> = {
  chart: ChartWidget,
  orderflow: OrderFlowMatrix,
  moneyflow: MoneyFlowProfile,
  chain: OptionChain,
  dom: DomLadder,
  scanner: PowerScanner,
  hlscanner: HighLowScanner,
  watchlist: Watchlist,
  media: MediaPanel,
};
