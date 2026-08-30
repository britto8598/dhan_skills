#!/usr/bin/env python3
"""Pre-flight order validation for DhanHQ orders.

This validator is intentionally conservative. It checks obvious SDK/order-rule
issues before an order is placed, while treating hardcoded lot sizes and freeze
quantities as fallback heuristics only.
"""

from __future__ import annotations

from datetime import datetime


# Fallback heuristics only. The security master (SEM_LOT_UNITS) is authoritative and
# is consulted first -- see _lot_size_from_master(). These literals exist so the
# validator still runs when pandas or the master download is unavailable.
#
# Verified 2026-08-31 against Dhan's api-scrip-master.csv (SEM_LOT_UNITS, OPTIDX rows,
# single distinct value per underlying). Exchanges revise these periodically; NIFTY
# alone went 75 -> 65 between 2026-07-10 and 2026-08-31. Re-verify before trusting.
LOT_SIZES = {
    "NIFTY": 65,
    "BANKNIFTY": 30,
    "FINNIFTY": 60,
    "MIDCPNIFTY": 120,
    "SENSEX": 20,
    "SENSEX50": 75,
    "BANKEX": 30,
}

# Fallback freeze-quantity heuristics only. UNVERIFIED -- these are the values that
# shipped with the skill and the security master carries no freeze column, so they
# have not been checked against the current exchange circulars. They drive a warning
# only, never an error. Confirm against NSE/BSE freeze limits before relying on them.
FREEZE_QTY = {
    "NIFTY": 1800,
    "BANKNIFTY": 900,
    "FINNIFTY": 1000,
    "MIDCPNIFTY": 2800,
    "SENSEX": 500,
}

VALID_EXCHANGE_SEGMENTS = {
    "NSE_EQ",
    "BSE_EQ",
    "NSE_FNO",
    "BSE_FNO",
    "MCX_COMM",
    "NSE_CURRENCY",
    "BSE_CURRENCY",
}

EQUITY_SEGMENTS = {"NSE_EQ", "BSE_EQ"}
DERIVATIVE_SEGMENTS = {"NSE_FNO", "BSE_FNO", "MCX_COMM", "NSE_CURRENCY", "BSE_CURRENCY"}

EQUITY_PRODUCT_TYPES = {"CNC", "INTRADAY", "MARGIN", "MTF"}
DERIVATIVE_PRODUCT_TYPES = {"INTRADAY", "MARGIN"}

VALID_ORDER_TYPES = {"LIMIT", "MARKET", "STOP_LOSS", "STOP_LOSS_MARKET"}
VALID_TRANSACTION_TYPES = {"BUY", "SELL"}
VALID_VALIDITY = {"DAY", "IOC"}

NOTIONAL_WARNING_THRESHOLD = 50000


def _underlying_of(trading_symbol: str | None) -> str | None:
    """Return the underlying token of a Dhan trading symbol.

    Dhan derivative symbols are ``UNDERLYING-MonYYYY-STRIKE-CE`` (for example
    ``BANKNIFTY-Oct2026-57000-CE``), so the underlying is the segment before the
    first hyphen. Falls back to the whole string for symbols without one.
    """

    if not trading_symbol:
        return None
    return trading_symbol.upper().split("-", 1)[0].strip() or None


def _lookup(table: dict[str, int], trading_symbol: str | None) -> int | None:
    """Match ``trading_symbol`` against ``table``.

    Exact match on the underlying token first. Only if that fails do we fall back
    to a substring scan, and that scan tries the LONGEST key first -- a plain
    ``for name in table`` scan matches "NIFTY" inside "BANKNIFTY", "FINNIFTY" and
    "MIDCPNIFTY", silently returning NIFTY's value for every index.
    """

    underlying = _underlying_of(trading_symbol)
    if underlying is None:
        return None

    if underlying in table:
        return table[underlying]

    for name in sorted(table, key=len, reverse=True):
        if name in underlying:
            return table[name]
    return None


def _lot_size_from_master(
    security_id: str | None, trading_symbol: str | None
) -> int | None:
    """Authoritative lot size from the security master, or None if unavailable.

    Kept optional on purpose: this module must stay importable without pandas or
    network access, so any failure falls through to the LOT_SIZES heuristic.
    """

    try:
        from dhan_helpers import get_lot_size
    except Exception:
        try:
            from scripts.dhan_helpers import get_lot_size
        except Exception:
            return None

    try:
        return get_lot_size(security_id=security_id, trading_symbol=trading_symbol)
    except Exception:
        return None


def _infer_lot_size(trading_symbol: str | None) -> int | None:
    return _lookup(LOT_SIZES, trading_symbol)


def _infer_freeze_qty(trading_symbol: str | None) -> int | None:
    return _lookup(FREEZE_QTY, trading_symbol)


def validate_order(
    *,
    security_id: str | None = None,
    exchange_segment: str | None = None,
    transaction_type: str | None = None,
    quantity: int | None = None,
    order_type: str | None = None,
    product_type: str | None = None,
    price: float = 0,
    trigger_price: float = 0,
    validity: str = "DAY",
    after_market_order: bool = False,
    trading_symbol: str | None = None,
    lot_size: int | None = None,
) -> dict[str, object]:
    """Validate common DhanHQ order parameters before placement."""

    errors: list[str] = []
    warnings: list[str] = []

    exchange_segment = exchange_segment.upper() if exchange_segment else exchange_segment
    transaction_type = transaction_type.upper() if transaction_type else transaction_type
    order_type = order_type.upper() if order_type else order_type
    product_type = product_type.upper() if product_type else product_type
    validity = validity.upper() if validity else validity

    if not security_id:
        errors.append("security_id is required")
    if not exchange_segment:
        errors.append("exchange_segment is required")
    if not transaction_type:
        errors.append("transaction_type is required")
    if quantity is None or quantity <= 0:
        errors.append("quantity must be a positive integer")
    if not order_type:
        errors.append("order_type is required")
    if not product_type:
        errors.append("product_type is required")

    if exchange_segment and exchange_segment not in VALID_EXCHANGE_SEGMENTS:
        errors.append(f"Invalid exchange_segment: {exchange_segment}")
    if transaction_type and transaction_type not in VALID_TRANSACTION_TYPES:
        errors.append(f"Invalid transaction_type: {transaction_type}")
    if order_type and order_type not in VALID_ORDER_TYPES:
        errors.append(f"Invalid order_type: {order_type}")
    if validity and validity not in VALID_VALIDITY:
        errors.append(f"Invalid validity: {validity}")

    if order_type in {"LIMIT", "STOP_LOSS"} and price <= 0:
        errors.append(f"price is required for {order_type} orders")
    if order_type in {"STOP_LOSS", "STOP_LOSS_MARKET"} and trigger_price <= 0:
        errors.append(f"trigger_price is required for {order_type} orders")

    if exchange_segment in EQUITY_SEGMENTS and product_type and product_type not in EQUITY_PRODUCT_TYPES:
        errors.append(
            f"Invalid product_type '{product_type}' for equity segment '{exchange_segment}'. "
            f"Valid values: {sorted(EQUITY_PRODUCT_TYPES)}"
        )

    if exchange_segment in DERIVATIVE_SEGMENTS and product_type and product_type not in DERIVATIVE_PRODUCT_TYPES:
        errors.append(
            f"Invalid product_type '{product_type}' for derivative segment '{exchange_segment}'. "
            f"Valid values: {sorted(DERIVATIVE_PRODUCT_TYPES)}"
        )

    if order_type == "MARKET":
        warnings.append(
            "Dhan's current order docs say API market orders are converted to limit orders with MPP."
        )

    effective_lot_size = (
        lot_size
        or _lot_size_from_master(security_id, trading_symbol)
        or _infer_lot_size(trading_symbol)
    )
    if exchange_segment in DERIVATIVE_SEGMENTS and quantity:
        if effective_lot_size is not None and quantity % effective_lot_size != 0:
            errors.append(
                f"Derivative quantity must be a multiple of lot size {effective_lot_size}. Got {quantity}."
            )
        elif effective_lot_size is None:
            warnings.append(
                "Could not resolve a lot size from the provided data. Confirm lot size from the security master before placing."
            )

        freeze_qty = _infer_freeze_qty(trading_symbol)
        if freeze_qty is not None and quantity > freeze_qty:
            warnings.append(
                f"Quantity {quantity} exceeds fallback freeze quantity {freeze_qty}. "
                "Consider place_slice_order() after verifying the latest exchange freeze limits."
            )

    if price and quantity:
        notional = price * quantity
        if notional > NOTIONAL_WARNING_THRESHOLD:
            warnings.append(
                f"High notional value: Rs. {notional:,.2f} exceeds the Rs. 50,000 warning threshold."
            )

    if not after_market_order:
        now = datetime.now()
        if now.weekday() >= 5:
            warnings.append("Market is closed on weekends. Use AMO only if that is intentional.")
        elif now.hour < 9 or (now.hour == 9 and now.minute < 15):
            warnings.append("Regular market is not yet open.")
        elif now.hour > 15 or (now.hour == 15 and now.minute > 30):
            warnings.append("Regular market is closed. Use AMO only if that is intentional.")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
    }


def print_validation(result: dict[str, object]) -> None:
    """Pretty-print validation output."""

    if result["valid"]:
        print("Order validation: PASS")
    else:
        print("Order validation: FAIL")
        for error in result["errors"]:
            print(f"  ERROR: {error}")

    for warning in result["warnings"]:
        print(f"  WARNING: {warning}")


if __name__ == "__main__":
    sample = validate_order(
        security_id="2885",
        exchange_segment="NSE_EQ",
        transaction_type="BUY",
        quantity=10,
        order_type="LIMIT",
        product_type="CNC",
        price=2450,
    )
    print_validation(sample)
