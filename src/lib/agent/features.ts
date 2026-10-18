/**
 * Every tool family registers itself here (side-effect imports). Desktop-only tools declare
 * platforms: ["desktop"] and are filtered out on web and mobile.
 */
import "./builtin";
import "../visualize/tool";
import "../mcp";
