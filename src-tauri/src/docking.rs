use std::{sync::OnceLock, time::Instant};

pub fn now() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Rect {
    fn right(self) -> i32 {
        self.x + self.width
    }
    fn bottom(self) -> i32 {
        self.y + self.height
    }
    fn contains(self, point: (i32, i32)) -> bool {
        point.0 >= self.x && point.0 < self.right() && point.1 >= self.y && point.1 < self.bottom()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

pub struct Frame {
    pub enabled: bool,
    pub rect: Rect,
    pub area: Rect,
    pub scale: f64,
    pub cursor: Option<(i32, i32)>,
    pub pointer_on_window: bool,
    pub mouse_down: bool,
    pub panel_open: bool,
    pub now: u64,
}

#[derive(Default)]
pub struct Plan {
    pub position: Option<(i32, i32)>,
    // Outer None means unchanged; Some(None) removes the native clipping region.
    pub clip: Option<Option<Rect>>,
    pub raise: bool,
}

#[derive(Default)]
pub struct Docking {
    edge: Option<Edge>,
    hidden: bool,
    clip: Option<Rect>,
    clip_dirty: bool,
    expected: Option<Rect>,
    area: Option<Rect>,
    moved_at: u64,
    outside_since: Option<u64>,
    reveal_until: u64,
    edge_hovered: bool,
}

impl Docking {
    pub fn reveal(&mut self, now: u64) {
        self.hidden = false;
        self.clip = None;
        self.outside_since = None;
        self.reveal_until = now + 1000;
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn retry_clip(&mut self) {
        self.clip_dirty = true;
    }
    pub fn needs_update(&self) -> bool {
        self.edge.is_some() || self.clip.is_some() || self.clip_dirty
    }

    pub fn update(&mut self, frame: Frame) -> Plan {
        let mut plan = Plan::default();
        if !frame.enabled {
            if self.clip.is_some() || self.clip_dirty {
                plan.clip = Some(None);
            }
            self.reset();
            return plan;
        }
        let size_changed = self
            .expected
            .is_some_and(|r| r.width != frame.rect.width || r.height != frame.rect.height);
        let moved = self
            .expected
            .is_some_and(|r| r.x != frame.rect.x || r.y != frame.rect.y);
        // A user move releases the attachment. Native resize keeps the same edge.
        if (moved && !size_changed)
            || (frame.mouse_down && !self.hidden)
            || self.area.is_some_and(|a| a != frame.area)
        {
            self.edge = None;
            self.hidden = false;
            self.outside_since = None;
            self.edge_hovered = false;
            self.moved_at = frame.now;
        }
        let mut rect = frame.rect;
        if self.edge.is_none()
            && !frame.mouse_down
            && frame.now.saturating_sub(self.moved_at) >= 150
        {
            let threshold = (16.0 * frame.scale).round() as i32;
            self.edge = [
                (Edge::Left, (rect.x - frame.area.x).abs()),
                (Edge::Right, (rect.right() - frame.area.right()).abs()),
                (Edge::Top, (rect.y - frame.area.y).abs()),
                (Edge::Bottom, (rect.bottom() - frame.area.bottom()).abs()),
            ]
            .into_iter()
            .filter(|(_, distance)| *distance <= threshold)
            .min_by_key(|(_, distance)| *distance)
            .map(|(edge, _)| edge);
        }
        if let Some(edge) = self.edge {
            rect.x = rect.x.clamp(
                frame.area.x,
                (frame.area.right() - rect.width).max(frame.area.x),
            );
            rect.y = rect.y.clamp(
                frame.area.y,
                (frame.area.bottom() - rect.height).max(frame.area.y),
            );
            match edge {
                Edge::Left => rect.x = frame.area.x,
                Edge::Right => rect.x = (frame.area.right() - rect.width).max(frame.area.x),
                Edge::Top => rect.y = frame.area.y,
                Edge::Bottom => rect.y = (frame.area.bottom() - rect.height).max(frame.area.y),
            }
            if (rect.x, rect.y) != (frame.rect.x, frame.rect.y) {
                plan.position = Some((rect.x, rect.y));
            }
            let strip = (10.0 * frame.scale).round().max(1.0) as i32;
            let strip_rect = match edge {
                Edge::Left => Rect {
                    width: strip.min(rect.width),
                    ..rect
                },
                Edge::Right => Rect {
                    x: rect.right() - strip.min(rect.width),
                    width: strip.min(rect.width),
                    ..rect
                },
                Edge::Top => Rect {
                    height: strip.min(rect.height),
                    ..rect
                },
                Edge::Bottom => Rect {
                    y: rect.bottom() - strip.min(rect.height),
                    height: strip.min(rect.height),
                    ..rect
                },
            };
            let edge_hover = frame.cursor.is_some_and(|p| strip_rect.contains(p));
            let edge_entered = edge_hover && !self.edge_hovered;
            self.edge_hovered = edge_hover;
            // A covered window must not treat the other app's mouse activity
            // as its own hover. Entering the edge can also raise an already
            // expanded window that another app covered before the hide delay.
            let hover = !self.hidden
                && frame.pointer_on_window
                && frame.cursor.is_some_and(|p| rect.contains(p));
            if edge_entered || hover || frame.panel_open || frame.now < self.reveal_until {
                plan.raise = edge_entered && (self.hidden || !frame.pointer_on_window);
                self.hidden = false;
                self.outside_since = None;
            } else if !self.hidden {
                let since = self.outside_since.get_or_insert(frame.now);
                if frame.now.saturating_sub(*since) >= 800 {
                    self.hidden = true;
                }
            }
            let clip = self.hidden.then_some(Rect {
                x: strip_rect.x - rect.x,
                y: strip_rect.y - rect.y,
                ..strip_rect
            });
            if clip != self.clip || self.clip_dirty {
                plan.clip = Some(clip);
                self.clip = clip;
            }
        } else if self.clip.take().is_some() || self.clip_dirty {
            plan.clip = Some(None);
        }
        self.clip_dirty = false;
        self.expected = Some(rect);
        self.area = Some(frame.area);
        plan
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(rect: Rect, now: u64) -> Frame {
        Frame {
            enabled: true,
            rect,
            area: Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
            },
            scale: 1.0,
            cursor: Some((900, 900)),
            pointer_on_window: true,
            mouse_down: false,
            panel_open: false,
            now,
        }
    }
    #[test]
    fn all_edges_snap_hide_and_reveal_without_changing_content_size() {
        for (rect, edge, point) in [
            (
                Rect {
                    x: 8,
                    y: 200,
                    width: 220,
                    height: 600,
                },
                Edge::Left,
                (1, 300),
            ),
            (
                Rect {
                    x: 1692,
                    y: 200,
                    width: 220,
                    height: 600,
                },
                Edge::Right,
                (1919, 300),
            ),
            (
                Rect {
                    x: 300,
                    y: 8,
                    width: 220,
                    height: 600,
                },
                Edge::Top,
                (400, 1),
            ),
            (
                Rect {
                    x: 300,
                    y: 432,
                    width: 220,
                    height: 600,
                },
                Edge::Bottom,
                (400, 1039),
            ),
        ] {
            let mut dock = Docking::default();
            let snap = dock.update(frame(rect, 200));
            assert!(snap.position.is_some());
            let (x, y) = snap.position.unwrap();
            let rect = Rect { x, y, ..rect };
            assert_eq!(dock.edge, Some(edge));
            let hide = dock.update(frame(rect, 1000));
            assert!(dock.hidden);
            assert!(hide.clip.unwrap().is_some());
            let mut input = frame(rect, 1100);
            input.cursor = Some(point);
            let reveal = dock.update(input);
            assert_eq!(reveal.clip, Some(None));
            assert!(reveal.raise);
            assert!(!dock.hidden);
            assert_eq!(dock.expected.unwrap(), rect);
        }
    }
    #[test]
    fn drag_release_panels_and_disabling_restore_the_full_window() {
        let rect = Rect {
            x: 0,
            y: 200,
            width: 220,
            height: 600,
        };
        let mut dock = Docking::default();
        let mut input = frame(rect, 200);
        input.mouse_down = true;
        dock.update(input);
        assert!(dock.edge.is_none());
        dock.update(frame(rect, 400));
        let mut input = frame(rect, 2000);
        input.panel_open = true;
        dock.update(input);
        assert!(!dock.hidden);
        dock.update(frame(rect, 2100));
        dock.update(frame(rect, 3000));
        assert!(dock.hidden);
        let mut input = frame(rect, 3100);
        input.enabled = false;
        assert_eq!(dock.update(input).clip, Some(None));
        assert!(dock.edge.is_none());
        dock.update(frame(rect, 3400));
        dock.update(frame(rect, 4300));
        let mut input = frame(rect, 4400);
        input.mouse_down = true;
        input.cursor = Some((1, 300));
        assert_eq!(dock.update(input).clip, Some(None));
        assert!(!dock.hidden);
    }
    #[test]
    fn negative_monitor_coordinates_dpi_resize_and_detachment() {
        let mut dock = Docking::default();
        let rect = Rect {
            x: -1910,
            y: -100,
            width: 280,
            height: 700,
        };
        let area = Rect {
            x: -1920,
            y: -300,
            width: 1920,
            height: 1200,
        };
        let mut input = frame(rect, 200);
        input.area = area;
        input.scale = 1.5;
        assert_eq!(dock.update(input).position, Some((-1920, -100)));
        let mut input = frame(
            Rect {
                x: -1920,
                width: 340,
                height: 850,
                ..rect
            },
            1000,
        );
        input.area = area;
        input.scale = 1.5;
        let clip = dock.update(input).clip.unwrap().unwrap();
        assert_eq!(clip.width, 15);
        assert_eq!(clip.height, 850);
        let mut input = frame(
            Rect {
                x: -1000,
                y: -100,
                width: 340,
                height: 850,
            },
            1100,
        );
        input.area = area;
        assert_eq!(dock.update(input).clip, Some(None));
        assert!(dock.edge.is_none());
    }
    #[test]
    fn hidden_window_only_opens_from_its_strip_and_ignores_other_desktop_clicks() {
        let rect = Rect {
            x: 0,
            y: 200,
            width: 220,
            height: 600,
        };
        let mut dock = Docking::default();
        dock.update(frame(rect, 200));
        dock.update(frame(rect, 1000));
        let mut input = frame(rect, 1100);
        input.cursor = Some((100, 300));
        assert!(dock.update(input).clip.is_none());
        assert!(dock.hidden);
        let mut input = frame(rect, 1200);
        input.mouse_down = true;
        assert!(dock.update(input).clip.is_none());
        assert!(dock.hidden);
        let mut input = frame(rect, 1300);
        input.cursor = Some((2, 300));
        assert_eq!(dock.update(input).clip, Some(None));
        assert!(!dock.hidden);
    }
    #[test]
    fn entering_covered_edge_raises_even_before_window_has_hidden() {
        let rect = Rect {
            x: 0,
            y: 200,
            width: 220,
            height: 600,
        };
        let mut dock = Docking::default();
        let mut input = frame(rect, 200);
        input.cursor = Some((100, 300));
        input.pointer_on_window = false;
        dock.update(input);
        assert!(!dock.hidden);
        let mut input = frame(rect, 300);
        input.cursor = Some((2, 300));
        input.pointer_on_window = false;
        assert!(
            dock.update(input).raise,
            "covered expanded window still needs to be raised"
        );
    }
    #[test]
    fn covered_hover_does_not_prevent_hiding_or_keep_raising_over_the_cover() {
        let rect = Rect {
            x: 0,
            y: 200,
            width: 220,
            height: 600,
        };
        let mut dock = Docking::default();
        for now in [200, 1000] {
            let mut input = frame(rect, now);
            input.cursor = Some((100, 300));
            input.pointer_on_window = false;
            dock.update(input);
        }
        assert!(
            dock.hidden,
            "mouse over a covering app is not a dashboard hover"
        );
        for (now, expected_raise) in [(1100, true), (1200, false), (2100, false), (2200, false)] {
            let mut input = frame(rect, now);
            input.cursor = Some((2, 300));
            input.pointer_on_window = false;
            assert_eq!(dock.update(input).raise, expected_raise);
        }
        assert!(
            dock.hidden,
            "a topmost overlay can stay in front without a raise loop"
        );
    }
}
