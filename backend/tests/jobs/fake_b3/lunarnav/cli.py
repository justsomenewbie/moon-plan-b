"""FAKE `lunarnav.cli` (B3 tests): only build_parser() for the capabilities probe."""
import argparse


def build_parser():
    ap = argparse.ArgumentParser(prog="lunarnav")
    sub = ap.add_subparsers(dest="command")
    sub.add_parser("check").add_argument("dir")
    v = sub.add_parser("validate")
    v.add_argument("--quick", action="store_true")
    return ap
