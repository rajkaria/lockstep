import argparse


def main() -> None:
    parser = argparse.ArgumentParser(prog="tool2")
    subs = parser.add_subparsers(dest="cmd")
    subs.add_parser("sync")
    subs.add_parser("status")
    parser.parse_args()
