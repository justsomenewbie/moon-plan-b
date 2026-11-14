"""FAKE lunarnav.cli: only build_parser() for the capabilities probe (precompute has --near-exclusion-m)."""
import argparse


def build_parser():
    ap = argparse.ArgumentParser(prog="lunarnav")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("precompute")
    p.add_argument("--near-exclusion-m")
    return ap
