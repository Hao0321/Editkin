// Generated from the approved longform70 declarative profile. New native variant, never a certified default.
// Geometry/motion/font/color overrides are exact; historical copy, IDs and timeline examples are intentionally absent.
export const LONGFORM70_CATALOG_V1 = {
  "schema": "editkin.longform70-native-scene-catalog/v1",
  "id": "hao-longform-70-native-v1",
  "designProfileSha256": "0bf27ea50f2c44900e6a72520c5e2013dbaaffbb4b0837ab13ee1b875dab44bc",
  "certification": {
    "status": "ART_PENDING_CLAUDE",
    "selectableByDefault": false
  },
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "subtitleReservePixels": 200,
  "palette": {
    "primary": "#2457F5",
    "background": "#F4F4F0",
    "ink": "#111316",
    "grid": "#AAB0BB"
  },
  "recipes": [
    {
      "id": "number-hook",
      "narrativeRole": "開場真數字／規模鉤子",
      "elements": [
        {
          "slot": "paper-01",
          "presetId": "reel_native_panel",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "background",
            "x": 0,
            "y": 0,
            "width": 1,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 8,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector-stage/v1",
              "heightPixels": 1080,
              "revealFrames": 1,
              "kind": "panel"
            }
          }
        },
        {
          "slot": "grid-01",
          "presetId": "reel_line_grid",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "background",
            "x": 0.83,
            "y": 0.04,
            "width": 0.13,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "primary",
              "alphaHex": "50"
            },
            "backgroundColor": "#00000000",
            "accentColor": {
              "paletteRole": "grid",
              "alphaHex": "40"
            },
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 180,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector-stage/v1",
              "heightPixels": 780,
              "revealFrames": 1,
              "kind": "line_grid",
              "spacingPixels": 32,
              "lineWidthPixels": 1,
              "majorEvery": 4
            }
          }
        },
        {
          "slot": "count",
          "presetId": "reel_spatial_headline",
          "binding": "verified_number",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.065,
            "y": 0.095,
            "width": 0.84,
            "fontSize": 380,
            "fontWeight": 400,
            "fontFamily": "Bebas Neue",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 14,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "primary",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 380,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": -55,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "ease_out"
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "community",
          "presetId": "reel_spatial_headline",
          "binding": "number_context",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.075,
            "y": 0.565,
            "width": 0.85,
            "fontSize": 108,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 108,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        }
      ]
    },
    {
      "id": "contrast-claim",
      "narrativeRole": "問題或反直覺轉折",
      "elements": [
        {
          "slot": "ink-02",
          "presetId": "reel_native_panel",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "background",
            "x": 0,
            "y": 0,
            "width": 1,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 8,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector-stage/v1",
              "heightPixels": 1080,
              "revealFrames": 1,
              "kind": "panel"
            }
          }
        },
        {
          "slot": "not-more",
          "presetId": "reel_spatial_headline",
          "binding": "setup",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.07,
            "y": 0.14,
            "width": 0.85,
            "fontSize": 126,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 126,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "information",
          "presetId": "reel_spatial_headline",
          "binding": "focus_claim",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.07,
            "y": 0.355,
            "width": 0.86,
            "fontSize": 236,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "primary",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 236,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": -42,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        }
      ]
    },
    {
      "id": "relationship",
      "narrativeRole": "兩者找到彼此／共同完成",
      "elements": [
        {
          "slot": "blue-03",
          "presetId": "reel_native_panel",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "background",
            "x": 0,
            "y": 0,
            "width": 1,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": {
              "paletteRole": "primary",
              "alphaHex": "FF"
            },
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 8,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector-stage/v1",
              "heightPixels": 1080,
              "revealFrames": 1,
              "kind": "panel"
            }
          }
        },
        {
          "slot": "person-left",
          "presetId": "reel_native_disc",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "foreground",
            "x": 0.07,
            "y": 0.305,
            "width": 0.27,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 180,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 12,
                "offsetXPixels": -95,
                "offsetYPixels": 0,
                "scale": 0.82,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 5,
                "offsetXPixels": 0,
                "offsetYPixels": -14,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "ease_in"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector/v1",
              "heightPixels": 518.4000000000001,
              "revealFrames": 1,
              "kind": "ellipse"
            }
          }
        },
        {
          "slot": "person-right",
          "presetId": "reel_native_disc",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "foreground",
            "x": 0.655,
            "y": 0.305,
            "width": 0.27,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 180,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 12,
                "offsetXPixels": 95,
                "offsetYPixels": 0,
                "scale": 0.82,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 5,
                "offsetXPixels": 0,
                "offsetYPixels": -14,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "ease_in"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector/v1",
              "heightPixels": 518.4000000000001,
              "revealFrames": 1,
              "kind": "ellipse"
            }
          }
        },
        {
          "slot": "connection",
          "presetId": "reel_rule_reveal",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "foreground",
            "x": 0.34,
            "y": 0.544,
            "width": 0.315,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 180,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 5,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 5,
                "offsetXPixels": 0,
                "offsetYPixels": -14,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "ease_in"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector/v1",
              "heightPixels": 14,
              "revealFrames": 12,
              "kind": "rule"
            }
          }
        },
        {
          "slot": "find",
          "presetId": "reel_spatial_headline",
          "binding": "connection_claim",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.07,
            "y": 0.015,
            "width": 0.85,
            "fontSize": 230,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 230,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "make",
          "presetId": "reel_spatial_headline",
          "binding": "payoff_claim",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.07,
            "y": 0.015,
            "width": 0.86,
            "fontSize": 205,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 205,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        }
      ]
    },
    {
      "id": "recap-left",
      "narrativeRole": "行動回顧一：左側數字",
      "elements": [
        {
          "slot": "step01-blue",
          "presetId": "reel_native_panel",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "background",
            "x": 0,
            "y": 0,
            "width": 1,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": {
              "paletteRole": "primary",
              "alphaHex": "FF"
            },
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 8,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector-stage/v1",
              "heightPixels": 1080,
              "revealFrames": 1,
              "kind": "panel"
            }
          }
        },
        {
          "slot": "step01-number",
          "presetId": "reel_spatial_headline",
          "binding": "step_number",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.055,
            "y": 0.055,
            "width": 0.29,
            "fontSize": 380,
            "fontWeight": 400,
            "fontFamily": "Bebas Neue",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 14,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 380,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": -46,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "step01-main",
          "presetId": "reel_spatial_headline",
          "binding": "action",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.37,
            "y": 0.145,
            "width": 0.58,
            "fontSize": 190,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 190,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "step01-sub",
          "presetId": "reel_spatial_headline",
          "binding": "support",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.375,
            "y": 0.46,
            "width": 0.58,
            "fontSize": 126,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 126,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        }
      ]
    },
    {
      "id": "recap-right",
      "narrativeRole": "行動回顧二：右側數字",
      "elements": [
        {
          "slot": "step02-paper",
          "presetId": "reel_native_panel",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "background",
            "x": 0,
            "y": 0,
            "width": 1,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 8,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector-stage/v1",
              "heightPixels": 1080,
              "revealFrames": 1,
              "kind": "panel"
            }
          }
        },
        {
          "slot": "step02-number",
          "presetId": "reel_spatial_headline",
          "binding": "step_number",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.65,
            "y": 0.055,
            "width": 0.29,
            "fontSize": 380,
            "fontWeight": 400,
            "fontFamily": "Bebas Neue",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 14,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "primary",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 380,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 46,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "step02-main",
          "presetId": "reel_spatial_headline",
          "binding": "action",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.065,
            "y": 0.155,
            "width": 0.58,
            "fontSize": 168,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 168,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "step02-sub",
          "presetId": "reel_spatial_headline",
          "binding": "support",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.07,
            "y": 0.46,
            "width": 0.58,
            "fontSize": 126,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "primary",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 126,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        }
      ]
    },
    {
      "id": "recap-ink",
      "narrativeRole": "行動回顧三：墨黑反相",
      "elements": [
        {
          "slot": "step03-ink",
          "presetId": "reel_native_panel",
          "authoringOverrides": {
            "kind": "card",
            "compositeLayer": "background",
            "x": 0,
            "y": 0,
            "width": 1,
            "fontSize": 180,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 8,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "all",
                "order": "forward",
                "exitOrder": "forward",
                "staggerFrames": 0
              },
              "entrance": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            },
            "vectorV2": {
              "schema": "editkin.motion-vector-stage/v1",
              "heightPixels": 1080,
              "revealFrames": 1,
              "kind": "panel"
            }
          }
        },
        {
          "slot": "step03-number",
          "presetId": "reel_spatial_headline",
          "binding": "step_number",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.055,
            "y": 0.055,
            "width": 0.29,
            "fontSize": 380,
            "fontWeight": 400,
            "fontFamily": "Bebas Neue",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 14,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "primary",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 380,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": -46,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "step03-main",
          "presetId": "reel_spatial_headline",
          "binding": "action",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.37,
            "y": 0.145,
            "width": 0.58,
            "fontSize": 190,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 190,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "step03-sub",
          "presetId": "reel_spatial_headline",
          "binding": "support",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.375,
            "y": 0.46,
            "width": 0.58,
            "fontSize": 132,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 132,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        }
      ]
    },
    {
      "id": "domain-cta",
      "narrativeRole": "一行主網址／品牌",
      "sceneBackgroundRole": "background",
      "elements": [
        {
          "slot": "url",
          "presetId": "reel_spatial_headline",
          "binding": "verified_domain",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.065,
            "y": 0.15,
            "width": 0.87,
            "fontSize": 286,
            "fontWeight": 400,
            "fontFamily": "Bebas Neue",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 8,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "primary",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 286,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": -42,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "url-brand",
          "presetId": "reel_spatial_headline",
          "binding": "brand",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.075,
            "y": 0.6,
            "width": 0.5,
            "fontSize": 105,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 105,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        }
      ]
    },
    {
      "id": "invitation",
      "narrativeRole": "口語邀請與下一個動作",
      "sceneBackgroundRole": "primary",
      "elements": [
        {
          "slot": "invite",
          "presetId": "reel_spatial_headline",
          "binding": "invitation",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.075,
            "y": 0.105,
            "width": 0.86,
            "fontSize": 240,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 240,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": -42,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "invite-brand",
          "presetId": "reel_spatial_headline",
          "binding": "brand",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.075,
            "y": 0.525,
            "width": 0.54,
            "fontSize": 108,
            "fontWeight": 900,
            "fontFamily": "Noto Sans TC",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "ink",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 108,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        },
        {
          "slot": "invite-url",
          "presetId": "reel_spatial_headline",
          "binding": "verified_domain",
          "authoringOverrides": {
            "kind": "title",
            "compositeLayer": "foreground",
            "x": 0.62,
            "y": 0.625,
            "width": 0.34,
            "fontSize": 62,
            "fontWeight": 400,
            "fontFamily": "Bebas Neue",
            "outlineWidth": 0,
            "shadowDepth": 0,
            "letterSpacing": 0,
            "cornerRadius": 0,
            "textColor": {
              "paletteRole": "background",
              "alphaHex": "FF"
            },
            "backgroundColor": "#00000000",
            "accentColor": "#00000000",
            "layoutV2": {
              "safeArea": {
                "top": 0,
                "right": 0,
                "bottom": 0.18518518518518517,
                "left": 0
              },
              "maxLines": 1,
              "minFontSize": 62,
              "lineGap": 0,
              "align": "left",
              "widthMode": "fixed"
            },
            "motionV2": {
              "sequence": {
                "unit": "character",
                "order": "forward",
                "exitOrder": "reverse",
                "staggerFrames": 2
              },
              "entrance": {
                "durationFrames": 9,
                "offsetXPixels": 0,
                "offsetYPixels": 34,
                "scale": 1,
                "opacity": 0,
                "easing": {
                  "type": "cubic_bezier",
                  "x1": 0.22,
                  "y1": 1,
                  "x2": 0.36,
                  "y2": 1
                }
              },
              "exit": {
                "durationFrames": 1,
                "offsetXPixels": 0,
                "offsetYPixels": 0,
                "scale": 1,
                "opacity": 1,
                "easing": {
                  "type": "linear"
                }
              }
            }
          }
        }
      ]
    }
  ]
} as const;
