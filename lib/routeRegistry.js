'use strict';

const store = require('./store');

/**
 * Route Matching & Registry Engine
 *
 * Evaluates incoming requests against registered routes with:
 * - Specificity ranking (exact matches > longest prefix wildcard > general wildcard)
 * - HTTP method validation
 * - Enabled / disabled route status checking
 * - Route-specific auth and timeout policies
 */

function pathToRegex(pattern) {
  if (pattern === '*' || pattern === '/*') {
    return { regex: /.*/, specificity: 0 };
  }

  // Escape special regex chars except '*'
  const escaped = pattern
    .replace(/[-[\]{}()+?.,\\^$|#\s]/g, '\\$&')
    .replace(/\*/g, '.*');

  const regex = new RegExp(`^${escaped}$`);
  // Specificity based on literal length before wildcard
  const literalPart = pattern.split('*')[0];
  const specificity = literalPart.length + (pattern.includes('*') ? 0 : 100);

  return { regex, specificity };
}

class RouteRegistry {
  constructor() {
    this.store = store;
  }

  getRoutes() {
    return this.store.getRoutes();
  }

  getRouteById(id) {
    return this.store.getRoute(id);
  }

  saveRoute(route) {
    return this.store.saveRoute(route);
  }

  deleteRoute(id) {
    return this.store.deleteRoute(id);
  }

  /**
   * Match incoming method and path to a registered route.
   *
   * @param {string} method  HTTP method e.g. 'GET'
   * @param {string} path    HTTP pathname e.g. '/api/users/123'
   * @returns {object} Match result:
   *   {
   *     matched: boolean,
   *     route: object|null,
   *     disabled: boolean,
   *     methodNotAllowed: boolean,
   *     allowedMethods: string[]
   *   }
   */
  match(method, path) {
    const cleanPath = path.split('?')[0];
    const upperMethod = method.toUpperCase();
    const routes = this.store.getRoutes();

    // Compile and score matches
    const candidates = [];

    for (const route of routes) {
      const { regex, specificity } = pathToRegex(route.path);
      if (regex.test(cleanPath)) {
        candidates.push({ route, specificity });
      }
    }

    if (candidates.length === 0) {
      return {
        matched: false,
        route: null,
        disabled: false,
        methodNotAllowed: false,
        allowedMethods: [],
      };
    }

    // Sort by highest specificity first
    candidates.sort((a, b) => b.specificity - a.specificity);
    const chosen = candidates[0].route;

    // Check if route is disabled
    if (!chosen.enabled) {
      return {
        matched: true,
        route: chosen,
        disabled: true,
        methodNotAllowed: false,
        allowedMethods: chosen.methods || ['*'],
      };
    }

    // Check method
    const allowedMethods = (chosen.methods || ['*']).map(m => m.toUpperCase());
    const isMethodAllowed = allowedMethods.includes('*') || allowedMethods.includes(upperMethod);

    if (!isMethodAllowed) {
      return {
        matched: true,
        route: chosen,
        disabled: false,
        methodNotAllowed: true,
        allowedMethods,
      };
    }

    return {
      matched: true,
      route: chosen,
      disabled: false,
      methodNotAllowed: false,
      allowedMethods,
    };
  }
}

module.exports = new RouteRegistry();
