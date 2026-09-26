// dsh-input-history - static host half (composition plugin row).
//
// This plugin is CLIENT-ONLY behavior: the browser half (src/client.js ->
// lib/client.js) listens for ArrowUp/ArrowDown on the web composer and
// recalls previously sent messages from localStorage. The host face exists
// only because the bundle patch layer names a composition plugin row; it
// registers no services, no routes, and never touches conversations.

export const name = 'dsh-input-history'

export const inject = []

export function apply(_ctx) {
  // Intentionally empty: all behavior lives in the client half.
}