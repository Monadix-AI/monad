#!/bin/bash
set -e

# Eden Treaty types are derived from apps/monad's App type. Build apps/monad once before
# staged checking to ensure downstream type resolution stays warm for client packages.
needs_monad_build=false
for file in "$@"; do
  if [[ $file == apps/cli/* ]] || [[ $file == packages/client-rtk/* ]] || [[ $file == packages/client/* ]]; then
    needs_monad_build=true
    break
  fi
done
if $needs_monad_build; then
  echo "🔨 Building apps/monad declaration files for treaty type resolution..."
  monad_build_config="apps/monad/tsconfig.build.json"
  if [ ! -f "$monad_build_config" ]; then
    monad_build_config="apps/monad/tsconfig.json"
  fi
  bunx tsc --build "$monad_build_config" 2>/dev/null
fi

workspaces=""

for file in "$@"; do
  if [[ $file == apps/* ]] || [[ $file == packages/* ]]; then
    if [[ $file =~ \.(ts|tsx)$ ]]; then
      workspace_type=$(echo "$file" | cut -d'/' -f1)
      workspace_name=$(echo "$file" | cut -d'/' -f2)
      workspace_path="$workspace_type/$workspace_name"

      if [ -d "$workspace_path" ]; then
        # Collect unique workspaces
        if ! echo "$workspaces" | grep -q "^$workspace_path$"; then
          workspaces="$workspaces"$'\n'"$workspace_path"
        fi

        # Resolve relative file path within the workspace
        relative_file=$(echo "$file" | cut -d'/' -f3-)

        # Get the actual filename with correct casing from the filesystem
        # This fixes issues where git reports a different case than the actual file
        if [ -f "$file" ]; then
          # Use Python to get the real path with correct casing (works on case-insensitive filesystems like macOS)
          actual_path=$(python3 -c "import os; print(os.path.realpath('$file'))" 2>/dev/null || echo "$file")
          actual_relative_file=$(echo "$actual_path" | sed "s|.*/$(echo "$workspace_path" | sed 's|/|\\/|g')/||")
          echo "$actual_relative_file" >> "/tmp/.typecheck_${workspace_type}_${workspace_name}.txt"
        fi
      fi
    fi
  fi
done

# Loop through each workspace and run type checking
IFS=$'\n'
for workspace in $workspaces; do
  if [ -n "$workspace" ]; then
    workspace_type=$(echo "$workspace" | cut -d'/' -f1)
    workspace_name=$(echo "$workspace" | cut -d'/' -f2)
    tmp_file="/tmp/.typecheck_${workspace_type}_${workspace_name}.txt"

    if [ -f "$tmp_file" ]; then
      echo "🔍 Type checking $workspace..."

      # Read tsconfig.json and create a temporary config
      cd "$workspace"

      staged_config=".tsconfig.staged.json"

      if [ -f "tsconfig.json" ]; then
        # Create a temporary tsconfig that extends the original but only checks staged files
        # Filter out files that don't exist (e.g., deleted files in staged changes)
        # Use case-insensitive sort and unique to handle renamed files with case changes
        files_json=$(cat "$tmp_file" | sort -f | uniq -i | while read -r file; do
          if [ -f "$file" ]; then
            echo "\"$file\""
          fi
        done | paste -sd ',' -)

        # Include ambient declaration files so that global type augmentations
        # (e.g., Window extensions, CSS modules) are available during staged typecheck.
        extra_files=""
        if [ -f "next-env.d.ts" ]; then
          extra_files='"next-env.d.ts",'
        fi
        if [ -f "forge.env.d.ts" ]; then
          extra_files="${extra_files}\"forge.env.d.ts\","
        fi
        # Include root-level ambient .d.ts files (e.g., globals.d.ts for CSS module declarations)
        for dts_file in *.d.ts; do
          if [ -f "$dts_file" ] && [ "$dts_file" != "next-env.d.ts" ] && [ "$dts_file" != "forge.env.d.ts" ]; then
            extra_files="${extra_files}\"$dts_file\","
          fi
        done
        # Include all ambient .d.ts files from src/types/ (e.g., Window augmentations)
        if [ -d "src/types" ]; then
          for dts_file in src/types/*.d.ts; do
            if [ -f "$dts_file" ]; then
              extra_files="${extra_files}\"$dts_file\","
            fi
          done
        fi

        cat > "$staged_config" << EOF
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "disableReferencedProjectLoad": true },
  "include": [],
  "files": [$extra_files$files_json]
}
EOF

        # Use trap to ensure the temporary file is deleted even if the command fails
        trap "rm -f '$staged_config'" EXIT

        # Capture output and filter errors from files outside this workspace
        # (e.g. project references pulling in ../monad/* when checking apps/web)
        # Also filter indented continuation lines that belong to a filtered error.
        tsgo_output=$(bunx tsgo --noEmit --project "./$staged_config" 2>&1) || true
        filtered_output=$(echo "$tsgo_output" | awk '
          /^\.\.\// { skip=1; next }
          /^[[:space:]]/ { if (skip) next; print; next }
          { skip=0; print }
        ')
        if [ -n "$filtered_output" ]; then
          echo "$filtered_output" >&2
          rm -f "$staged_config"
          trap - EXIT
          exit 1
        fi

        rm -f "$staged_config"
        trap - EXIT
      else
        # If no tsconfig.json, type check the files directly
        files=$(cat "$tmp_file" | tr '\n' ' ')
        bunx tsgo --noEmit --skipLibCheck $files
      fi

      cd ../..
      rm -f "$tmp_file"
    fi
  fi
done
unset IFS
