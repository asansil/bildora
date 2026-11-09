"""A console program that asks its questions in a text menu, and knows nothing about Bildora."""

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Writes a greeting in the format you choose.")
    parser.add_argument("--upper", action="store_true", help="write the greeting in capitals")
    options = parser.parse_args()

    print("Greeting writer")
    print("---------------")
    print("  csv   one line of comma-separated values")
    print("  json  a JSON object")
    output_format = input("Format [csv/json]: ").strip().lower()
    if output_format not in ("csv", "json"):
        print(f"Unknown format: {output_format}", file=sys.stderr)
        return 2

    name = input("Your name: ").strip()
    if input("Continue? [y/n] ").strip().lower() != "y":
        print("Cancelled")
        return 1

    greeting = f"Hello, {name}"
    if options.upper:
        greeting = greeting.upper()
    if output_format == "csv":
        print(f"greeting,name\n{greeting},{name}")
    else:
        print(f'{{"greeting": "{greeting}", "name": "{name}"}}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
