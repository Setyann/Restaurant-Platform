import { supabase } from './supabaseClient.js'
import { toOrderItems, normalizeNote } from '../utils/cart.js'
import { parseOrderError } from '../utils/orderErrors.js'

// Guest side. The database checks the plan and the table token, recalculates prices
// and applies the anti-spam limits. requestId makes a retry safe (no duplicate order).
export async function placeOrder({ slug, token, note, cart, requestId }) {
  const { data, error } = await supabase.rpc('place_order', {
    p_slug: slug,
    p_table_token: token,
    p_note: normalizeNote(note),
    p_items: toOrderItems(cart),
    p_request_id: requestId
  })

  if (error) {
    const failure = new Error(error.message)
    failure.code = parseOrderError(error)
    throw failure
  }

  return data
}

// Anyone who knows the order id can read its status (the id is a random UUID).
export async function getOrderStatus(orderId) {
  const { data, error } = await supabase.rpc('get_order_status', { p_order: orderId })
  if (error) throw error
  return data
}
