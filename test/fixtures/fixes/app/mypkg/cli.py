import argparse


def main() -> None:
    parser = argparse.ArgumentParser(prog="mytool")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--color", choices=["auto", "never"])
    parser.parse_args()
