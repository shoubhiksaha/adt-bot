import { Users } from "lucide-react";
import { lazy } from "react";
import { registerView } from "../registry";
import { installRoomEvents } from "./rooms";

/** LAN chat rooms: guests on the same network chat with each other and the host's bots. */
registerView({
  id: "rooms",
  label: "Rooms",
  icon: Users,
  order: 60,
  Component: lazy(() => import("./RoomsView")),
});

// Bots answer room messages even while the Rooms view is closed.
installRoomEvents();
